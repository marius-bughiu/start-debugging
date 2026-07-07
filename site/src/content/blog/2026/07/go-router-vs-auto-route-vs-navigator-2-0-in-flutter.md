---
title: "go_router vs auto_route vs Navigator 2.0 in Flutter"
description: "go_router and auto_route both sit on top of Navigator 2.0, so the real choice is declarative URL routing vs code-generated typed routes vs hand-rolling the Router API. A decision matrix with config for each, and when raw Navigator still wins."
pubDate: 2026-07-07
template: vs
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "auto-route"
  - "navigation"
---

Short answer: for most Flutter apps in 2026, use `go_router`. It is maintained by the Flutter team, it is the option the official docs point you at, and it turns URLs into screens with the least ceremony. Reach for `auto_route` when you want compile-time-checked, strongly-typed navigation calls and you are willing to run a code generator to get them. Only drop down to raw Navigator 2.0 (implementing `RouterDelegate` and `RouteInformationParser` yourself) when you have a genuinely unusual navigation model that neither package expresses, because you are signing up for a lot of boilerplate. And if your app is small and has no deep-link or web-URL requirements, plain imperative `Navigator.push` is still a perfectly good answer.

The thing almost everyone gets wrong in this comparison is treating the three as parallel choices. They are not. "Navigator 2.0" is the Flutter framework's `Router` API, and both `go_router` and `auto_route` are built on top of it. So the decision is not "package A vs package B vs the framework"; it is "which layer do I want to write my routing at." This post uses `go_router` 17.3.0, `auto_route` 11.1.0, Flutter 3.44 stable, and Dart 3.x.

## The layer cake: what "Navigator 2.0" actually is

Flutter has two navigation APIs living side by side.

Navigator 1.0 is the imperative one you already know: `Navigator.of(context).push(MaterialPageRoute(...))` and `Navigator.pop(context)`. You push and pop screens like a stack. It is simple and it works, and for a small app it is all you need.

Navigator 2.0, more precisely called the `Router` API, is declarative. Instead of imperatively pushing, you give the framework a list of `Page` objects that describe the entire stack, and when your app state changes you hand it a new list. Two pieces make it work: a `RouteInformationParser` that turns an incoming URL (`RouteInformation`) into your own app-specific data type, and a `RouterDelegate` that reads that data plus your app state and builds the `Navigator` with the right `pages`. The official [navigation and routing docs](https://docs.flutter.dev/ui/navigation) describe exactly this split.

The catch is that writing a correct `RouterDelegate` and `RouteInformationParser` by hand is a lot of work. You are responsible for parsing paths, maintaining the page list, handling the system back button, syncing browser URLs, and restoring deep links. The Flutter docs are direct about it:

> If you prefer not to use a routing package and would like full control over navigation and routing in your app, override `RouteInformationParser` and `RouterDelegate`.

That "if you prefer full control" is the tell. For everyone else, a routing package wraps that machinery. `go_router` and `auto_route` are both that wrapper. They consume Navigator 2.0; they do not compete with it. So when someone asks "go_router or Navigator 2.0?", the honest answer is that go_router *is* Navigator 2.0 with the boilerplate written for you.

## What go_router optimizes for: URLs as the source of truth

`go_router` is published by the verified `flutter.dev` publisher and is [maintained by the Flutter team](https://pub.dev/packages/go_router). Its model is URL-first: you declare a route table of path patterns, and navigation is a matter of going to a path. Deep links, web URLs, and in-app navigation all resolve through the same table, which is why a deep link and a button tap land on the same screen.

A minimal setup:

```dart
// Flutter 3.44, go_router 17.3.0
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'orders/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(routerConfig: router);
}
```

Navigation is a string:

```dart
// go_router 17.3.0 - navigate by URL
context.go('/orders/42');   // replace the stack, land on order 42
context.push('/orders/42'); // push on top of the current stack
```

The strength here is also the sharp edge: navigation targets are strings. `context.go('/orders/42')` is not checked by the compiler. Fat-finger the path or rename a route and you find out at runtime. `go_router` has an answer, [typed routes via `go_router_builder`](https://pub.dev/packages/go_router_builder), which generates typed `GoRouteData` classes so you can call `OrderRoute(id: 42).go(context)` instead. But that is opt-in code generation bolted onto a package whose default idiom is strings, and in practice a lot of go_router codebases never turn it on.

`go_router` also owns the two features people actually adopt it for. `ShellRoute` and `StatefulShellRoute.indexedStack` give you a persistent shell (a bottom nav bar that survives tab switches), and a top-level `redirect` callback handles auth gating for the whole tree. If you want the full walkthrough of shells and deep-link config, see [setting up nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

One status note that matters for a multi-year decision: the Flutter team lists `go_router` as feature-complete. Their [roadmap statement](https://pub.dev/packages/go_router) reads:

> This package is considered feature-complete. The Flutter team's primary focus will be on addressing bug fixes and ensuring stability.

Read that as stability, not abandonment. It means the API you learn today is unlikely to churn under you, and bug fixes still land. It also means large new capabilities are more likely to arrive as community packages than as core go_router features.

## What auto_route optimizes for: typed routes from code generation

`auto_route` 11.1.0 is a community package by Milad Akarie. It attacks the exact weakness in go_router's default: stringly-typed navigation. You annotate each page with `@RoutePage()`, run `build_runner`, and it generates a strongly-typed route for every screen. Navigation calls are then checked by the compiler and their arguments are typed.

```dart
// Flutter 3.44, auto_route 11.1.0
@RoutePage()
class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key, required this.orderId});
  final int orderId; // a real int, not a string yanked from a path

  @override
  Widget build(BuildContext context) => const Placeholder();
}

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, initial: true),
        AutoRoute(page: OrderRoute.page, path: '/orders/:id'),
      ];
}
```

After `dart run build_runner build`, navigation is typed end to end:

```dart
// auto_route 11.1.0 - typed navigation, checked by the compiler
context.router.push(OrderRoute(orderId: 42)); // orderId is an int
```

Rename `orderId`, change its type, or delete the route, and the code that navigates to it stops compiling. That is the whole pitch, and for a large app with dozens of screens and non-trivial arguments it is a real, daily productivity difference. You never serialize an object into a query string and parse it back out by hand.

`auto_route` also ships first-class equivalents of the go_router features. Nested navigation uses an `AutoRouter` widget as the outlet for child routes; tabbed navigation uses [`AutoTabsRouter`](https://pub.dev/packages/auto_route), which preserves off-screen tab state the way `StatefulShellRoute` does. Auth gating uses guards: you extend `AutoRouteGuard`, implement `onNavigation`, and attach the guard per-route or globally.

```dart
// auto_route 11.1.0 - a route guard
class AuthGuard extends AutoRouteGuard {
  @override
  void onNavigation(NavigationResolver resolver, StackRouter router) {
    if (isSignedIn) {
      resolver.next(true);
    } else {
      router.push(const LoginRoute());
    }
  }
}
```

The cost is the code generator. You add `auto_route_generator` and `build_runner` as dev dependencies, and every time you add or change a `@RoutePage` you regenerate. In active development you run `build_runner watch`. That is a real tax: slower cold builds, a generated `.gr.dart` file in your tree, and the occasional need to delete generated output and rebuild when things get out of sync. Whether typed navigation is worth a code-gen step is the central trade in this whole comparison.

## The decision, as a matrix

| Concern | go_router 17.3.0 | auto_route 11.1.0 | Raw Navigator 2.0 |
| --- | --- | --- | --- |
| Maintainer | Flutter team (flutter.dev) | Community (Milad Akarie) | Flutter framework |
| Navigation calls | Strings (`context.go('/x')`), typed opt-in via builder | Typed, compiler-checked by default | You define it |
| Code generation | No (optional for typed routes) | Yes (`build_runner`) | No |
| Deep links / web URLs | Built in | Built in | You implement it |
| Persistent shell / tabs | `StatefulShellRoute` | `AutoTabsRouter` | You implement it |
| Auth gating | `redirect` callback | `AutoRouteGuard` | You implement it |
| Boilerplate | Low | Low-to-medium (plus generated files) | High |
| Best when | Most apps; web; deep links | Large app, many typed args, you like codegen | Truly custom navigation model |

The rows that should drive your choice are "navigation calls" and "code generation." If compile-time-checked navigation matters enough to justify a build step, `auto_route`. If you would rather not run a generator and are comfortable with string paths (or will opt into `go_router_builder` later), `go_router`. Everything else, both packages do competently.

## When raw Navigator 2.0 is the right call (rarely)

Do not reach for a hand-written `RouterDelegate` just to feel in control. The situations where it genuinely pays off are narrow:

- Your navigation state does not map to a URL tree at all. Think a node-graph editor, a wizard whose stack is computed from a state machine, or an app where "the stack" is a projection of some other data structure. Package route tables assume a tree of paths; if your model is not that, you may fight the package more than the framework.
- You are building your own routing package or a framework-level abstraction and need the primitives directly.
- You need behavior at the `Page`/`Navigator.pages` level that neither package exposes.

For those cases, the raw API gives you total control over the `List<Page>` and the parse-and-restore cycle. For everything else, the boilerplate you would write is boilerplate the packages already wrote, tested, and ship. The Flutter docs' guidance is unambiguous: apps with advanced navigation needs "should use a routing package such as go_router," and the raw API is framed as the escape hatch for people who explicitly want full control.

## Don't forget: for a small app, Navigator 1.0 is still fine

There is a failure mode where a five-screen app adopts a routing package, a code generator, and a route-table abstraction it never needed. If your app has no web target, no deep links, and no requirement to reconstruct a screen from a URL, imperative navigation is not a legacy mistake, it is the right-sized tool:

```dart
// Flutter 3.44 - imperative navigation, still correct for simple apps
Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (context) => const SecondScreen(),
  ),
);
```

The official docs explicitly bless this for "small applications without complex deep linking." The moment you add a web build, shareable links, or a bottom nav that must survive tab switches, move to `go_router` or `auto_route`. Not before.

## The gotchas each choice hands you

A few things bite people after they have committed:

- **go_router: strings are unchecked.** Renaming a path is a silent breakage until you hit it at runtime. Either adopt `go_router_builder` for typed routes early, or keep every path in a single constants file and never inline a raw string.
- **go_router: `context` after an await.** Declarative navigation does not exempt you from the `use_build_context_synchronously` lint. Navigating with a stale `BuildContext` after an `async` gap is the same bug it always was; see [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- **auto_route: generated-file drift.** After a messy merge or a Dart SDK bump, the generated `.gr.dart` can go stale and produce baffling errors. The fix is almost always `dart run build_runner build --delete-conflicting-outputs`, not staring at the diff.
- **auto_route: another codegen tool in your pipeline.** If you already run Freezed, json_serializable, or Riverpod's generator, `auto_route` is one more thing that must stay in sync. On CI, a forgotten `build_runner` step fails the build, not your machine.
- **Both: deep links still need native config.** Neither package can make Android and iOS hand a URL to Flutter on its own. You still edit `AndroidManifest.xml` and the iOS entitlements to register your scheme or app links. The package resolves the URL once it arrives; getting it to arrive is platform work.
- **Migrating between them is not free.** go_router route tables and auto_route's annotated classes are structurally different. Switching mid-project means rewriting the route layer, so pick with the two-year horizon in mind, not this sprint.

If you are still deciding your broader stack rather than just routing, the same "official-and-boring vs feature-rich-community" tension shows up in state management too, which I walk through in [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), and in the platform choice itself in [Flutter vs React Native vs MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/).

The summary that survives contact with a real project: `go_router` is the default because it is official, stable, and URL-native. `auto_route` earns its keep on large apps where compile-time-checked navigation is worth a code generator. Raw Navigator 2.0 is for the rare app whose navigation model does not fit a route table. And plain `Navigator.push` is still the correct answer for a small app that does not need any of this. Pick the lowest layer that solves your actual problem, not the most powerful one.

## Related

- [How to set up nested routes and deep links with go_router in Flutter](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Flutter vs React Native vs MAUI for a new mobile project in 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Sources

- [Navigation and routing - Flutter docs](https://docs.flutter.dev/ui/navigation)
- [go_router - pub.dev (maintained by flutter.dev)](https://pub.dev/packages/go_router)
- [go_router_builder - pub.dev](https://pub.dev/packages/go_router_builder)
- [auto_route - pub.dev](https://pub.dev/packages/auto_route)
- [auto_route_library - Milad-Akarie on GitHub](https://github.com/Milad-Akarie/auto_route_library)
