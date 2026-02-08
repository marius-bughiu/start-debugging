---
title: "Flutter 3.x routing: tp_router tries to delete your route table (and it’s a compelling idea)"
description: "Flutter routing is one of those things you only notice when it hurts. The first few screens are easy. Then the app grows, paths evolve, and “just add another route” becomes a maintenance tax. On Jan 7, 2026, a community post proposed an opinionated fix: tp_router, a generator-driven router that aims for zero manual route-table…"
pubDate: 2026-01-08
tags:
  - "flutter"
---
Flutter routing is one of those things you only notice when it hurts. The first few screens are easy. Then the app grows, paths evolve, and “just add another route” becomes a maintenance tax. On Jan 7, 2026, a community post proposed an opinionated fix: `tp_router`, a generator-driven router that aims for **zero manual route-table configuration**.

Source thread: [tp\_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
Project links: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

### The failure mode: strings everywhere

Most teams have lived some version of this:

```dart
// Define route table
final routes = {
  '/user': (context) => UserPage(
    id: int.parse(ModalRoute.of(context)!.settings.arguments as String),
  ),
};

// Navigate
Navigator.pushNamed(context, '/user', arguments: '42');
```

It “works”, until it doesn’t: the route name changes, the argument type changes, and you get runtime crashes in parts of the app you did not touch.

### Annotation first, generation second

The pitch for `tp_router` is simple: annotate the page, run the generator, then navigate through generated types instead of strings.

From the post:

```dart
@TpRoute(path: '/user/:id')
class UserPage extends StatelessWidget {
  final int id; // Auto-parsed from path
  final String section;

  const UserPage({
    required this.id,
    this.section = 'profile',
    super.key,
  });
}

// Navigate by calling .tp()
UserRoute(id: 42, section: 'posts').tp(context);
```

That last line is the entire point: if you rename `section` or change `id` from `int` to `String`, you want the compiler to break your build, not your users.

### The real question: does it keep friction low as the app grows?

If you have used `auto_route`, you already know annotation-driven routing can work well, but you still end up writing a central list:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` is trying to remove that last step entirely.

### Getting it running in a Flutter 3.x project

The dependencies shown in the thread are:

```dart
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

Generate routes:

-   `dart run build_runner build`

And wire it up:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

If you want less routing boilerplate and more compile-time safety, `tp_router` is worth a quick spike. Even if you do not adopt it, the direction is right: treat navigation as typed API, not as stringly-typed folklore.
