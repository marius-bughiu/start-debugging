---
title: "Fix: go_router routes lose their page transition (NoTransitionPage) after upgrading go_router or migrating to material_ui"
description: "go_router 18 detects MaterialApp from package:material_ui, go_router 17 detects the one from package:flutter/material.dart. Mix the wrong pair and every GoRoute.builder silently becomes a NoTransitionPage: no slide, no Hero flight. Reproduced in both directions on Flutter 3.44.8 with go_router 17.5.0 and 18.1.4, plus three fixes and the traps in the pageBuilder workaround."
pubDate: 2026-11-20
template: how-to
tags:
  - "flutter"
  - "go_router"
  - "navigation"
  - "material_ui"
  - "migration"
---

**Short answer:** go_router picks a default page for every `GoRoute.builder` by looking for a `MaterialApp` or `CupertinoApp` ancestor of an **exact type**. Since go_router 18.0.0 that type comes from `package:material_ui` and `package:cupertino_ui`; up to 17.5.0 it came from `package:flutter/material.dart` and `package:flutter/cupertino.dart`. Those are different classes, so an app on the SDK `MaterialApp` with go_router 18, or an app migrated to `material_ui` with go_router 17, fails the check and gets a `NoTransitionPage` for every route: navigation becomes instant, the Cupertino slide on iOS and macOS disappears, and Hero animations stop flying. Nothing is logged unless `debugLogDiagnostics` is on. Fix it by matching the pair: stay on `go_router: ^17.5.0` until you migrate to `material_ui`, or migrate and use `go_router: ^18`. If you cannot match them yet, return the page yourself from `pageBuilder`, using the `MaterialPage` class from the **same** library as your `MaterialApp`. Everything below was reproduced with widget tests on Flutter 3.44.8 (Dart 3.12.2), go_router 17.5.0 and 18.1.4, material_ui 1.2.0 and cupertino_ui 1.0.2.

## Why go_router suddenly falls back to NoTransitionPage

When a route uses `builder` instead of `pageBuilder`, go_router has to wrap your widget in a `Page` itself. It decides which one once, the first time it builds, in `RouteBuilder._cacheAppType` (`lib/src/builder.dart` in go_router 18.1.4):

```dart
// go_router 18.1.4, lib/src/builder.dart (abridged)
if (elem != null && isMaterialApp(elem)) {
  log('Using MaterialApp configuration');
  _pageBuilderForAppType = pageBuilderForMaterialApp;
} else if (elem != null && isCupertinoApp(elem)) {
  log('Using CupertinoApp configuration');
  _pageBuilderForAppType = pageBuilderForCupertinoApp;
} else {
  log('Using WidgetsApp configuration');
  _pageBuilderForAppType = (...) => NoTransitionPage<void>(...);
}
```

`isMaterialApp` lives in `lib/src/pages/material.dart`:

```dart
// go_router 18.1.4, lib/src/pages/material.dart
import 'package:material_ui/material_ui.dart';

bool isMaterialApp(BuildContext context) =>
    context.findAncestorWidgetOfExactType<MaterialApp>() != null;
```

In 17.x the file was identical except for the import, which was `package:flutter/material.dart`. The cupertino side (`pages/cupertino.dart`) changed the same way, to `package:cupertino_ui/cupertino_ui.dart`. The 18.0.0 changelog entry is one line: "Migrates to material_ui and cupertino_ui."

On the Flutter versions where `material_ui` exists (3.44 and later), `package:flutter/material.dart` does not re-export `material_ui`. It still ships its own frozen copy of the Material library. Two classes named `MaterialApp` in two libraries are two unrelated types as far as Dart is concerned, and `findAncestorWidgetOfExactType` compares types, not names. So exactly one combination of app library and go_router major version works, and the other one lands in the `else` branch.

The fallback is quiet on purpose: `NoTransitionPage` is the correct default for a bare `WidgetsApp`, which has no design language to borrow a transition from. go_router has no way to tell "a `WidgetsApp` on purpose" apart from "a `MaterialApp` from the other library".

This bit people from both sides. [flutter/flutter#191132](https://github.com/flutter/flutter/issues/191132) reported go_router 17.5.0 dropping transitions for apps that had migrated to `material_ui`. The fix, [flutter/packages#12504](https://github.com/flutter/packages/pull/12504), shipped as go_router 18.0.0 and produced the inverse report, [flutter/flutter#192761](https://github.com/flutter/flutter/issues/192761), from apps still on `package:flutter/material.dart`. That second issue was closed as intended behaviour: 18.0.0 is a major version, and the expected path is to migrate the app to `material_ui` or stay on 17.x.

## Reproducing both directions in one widget test

The test below builds the same two routes under four app widgets, pushes `/details`, pumps 100 ms into the transition and reports which `Page` class go_router chose and whether the old page is still on screen (it is, mid-transition, only if something is animating).

```dart
// Flutter 3.44.8, Dart 3.12.2
// pubspec: go_router 18.1.4 (then 17.5.0), material_ui 1.2.0, cupertino_ui 1.0.2
import 'package:cupertino_ui/cupertino_ui.dart' as cui;
import 'package:flutter/cupertino.dart' as sdkc;
import 'package:flutter/material.dart' as sdk;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart' as mui;

GoRouter makeRouter() => GoRouter(routes: [
      GoRoute(path: '/', builder: (c, s) => const Text('Home')),
      GoRoute(path: '/details', builder: (c, s) => const Text('Details')),
    ]);

final apps = <String, Widget Function(GoRouter)>{
  'SDK MaterialApp': (r) => sdk.MaterialApp.router(routerConfig: r),
  'material_ui MaterialApp': (r) => mui.MaterialApp.router(routerConfig: r),
  'SDK CupertinoApp': (r) => sdkc.CupertinoApp.router(routerConfig: r),
  'cupertino_ui CupertinoApp': (r) => cui.CupertinoApp.router(routerConfig: r),
};

void main() {
  for (final app in apps.entries) {
    testWidgets(app.key, (tester) async {
      final router = makeRouter();
      addTearDown(router.dispose);
      await tester.pumpWidget(app.value(router));
      await tester.pumpAndSettle();

      router.push('/details');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final page = ModalRoute.of(tester.element(find.text('Details')))!.settings;
      final animating = find.text('Home').evaluate().isNotEmpty;
      print('${app.key} -> ${page.runtimeType}, animating=$animating');
      await tester.pumpAndSettle();
    });
  }
}
```

Output with go_router **18.1.4** (the current release when this was written):

```text
SDK MaterialApp -> NoTransitionPage<void>, animating=false
material_ui MaterialApp -> MaterialPage<void>, animating=true
SDK CupertinoApp -> NoTransitionPage<void>, animating=false
cupertino_ui CupertinoApp -> CupertinoPage<void>, animating=true
```

Output with go_router **17.5.0**, same project, only the go_router pin changed:

```text
SDK MaterialApp -> MaterialPage<void>, animating=true
material_ui MaterialApp -> NoTransitionPage<void>, animating=false
SDK CupertinoApp -> CupertinoPage<void>, animating=true
cupertino_ui CupertinoApp -> NoTransitionPage<void>, animating=false
```

Note what does **not** trigger the bug: the target platform, the theme, the Flutter version on its own. Only the pair "library of your `MaterialApp`/`CupertinoApp`" and "go_router major version" matters. That is also why a Dependabot or Renovate bump from 17.x to 18.x is enough to break an app nobody touched.

## How to confirm this is your problem in a real app

1. Set `debugLogDiagnostics: true` on your `GoRouter`, run the app, and look for the line `Using WidgetsApp configuration` in the console. If your root widget is a `MaterialApp` or `CupertinoApp` and you see that line, you have the mismatch. `Using MaterialApp configuration` means detection worked and the missing animation is something else.
2. Check which library your app widget comes from: search the file that builds `MaterialApp.router` for `import 'package:flutter/material.dart'` versus `import 'package:material_ui/material_ui.dart'`.
3. Check the resolved go_router version in `pubspec.lock`, not the constraint in `pubspec.yaml`. A constraint like `go_router: any` or a caret range widened by a bot can resolve to 18.x.

## The fix: make the app library and go_router major version agree

There are three ways out, in order of preference.

1. **Migrate the app to `material_ui` and `cupertino_ui`, and use go_router 18.** This is the direction the framework is going: the in-framework design libraries are formally deprecated in Flutter 3.50, according to the [migration guide](https://docs.flutter.dev/release/breaking-changes/material-ui-and-cupertino-ui). The guide's automated route is `dart fix --apply --code=migrate_design_widgets`, followed by `flutter pub add material_ui cupertino_ui` if `dart fix` did not add them. After that, `MaterialApp` resolves to the `material_ui` class, go_router 18 detects it, and plain `builder` routes get a `MaterialPage` again.
2. **Stay on the SDK libraries and pin go_router below 18.** If you are not ready to migrate, constrain the dependency so a bot cannot cross the major version for you:

   ```yaml
   # pubspec.yaml, Flutter 3.44.8, app still on package:flutter/material.dart
   dependencies:
     go_router: ">=17.5.0 <18.0.0"
   ```

   The reverse also applies. If you migrated to `material_ui` but something holds go_router at 17.x, the migration is what broke your transitions, and the fix is to move go_router to `^18.0.0`.
3. **Stop relying on detection: build the page yourself in `pageBuilder`.** go_router only consults the app type for routes that use `builder`. A route with `pageBuilder` gets exactly the `Page` you return. This works with either go_router major version and is the only option when the app and go_router cannot be matched yet, for example while a third-party package forces one of them.

## Writing a pageBuilder that survives either go_router version

Return the page class from the same library as your `MaterialApp`, and fill it the way go_router does internally. In 18.1.4, `RouteBuilder._buildPlatformAdapterPage` passes `key: state.pageKey`, `name: state.name ?? state.path`, the path and query parameters as `arguments`, and `restorationId: state.pageKey.value`. Mirroring that keeps state restoration and page identity identical to what `builder` routes had before:

```dart
// Flutter 3.44.8, go_router 18.1.4, app still on package:flutter/material.dart
import 'package:flutter/material.dart'; // SAME library as your MaterialApp
import 'package:go_router/go_router.dart';

/// The page go_router 17.x picked for a MaterialApp, built explicitly.
Page<void> platformPage(GoRouterState state, Widget child) => MaterialPage<void>(
      key: state.pageKey,
      name: state.name ?? state.path,
      arguments: <String, String>{
        ...state.pathParameters,
        ...state.uri.queryParameters,
      },
      restorationId: state.pageKey.value,
      child: child,
    );

final router = GoRouter(
  routes: [
    ShellRoute(
      pageBuilder: (context, state, child) =>
          platformPage(state, Scaffold(body: child)),
      routes: [
        GoRoute(
          path: '/',
          pageBuilder: (context, state) => platformPage(state, const Text('Home')),
          routes: [
            GoRoute(
              path: 'details/:id',
              pageBuilder: (context, state) =>
                  platformPage(state, Text('Details ${state.pathParameters['id']}')),
            ),
          ],
        ),
      ],
    ),
  ],
);
```

`MaterialPage` already resolves to a Cupertino slide on iOS and macOS through the theme's `PageTransitionsTheme`, so you do not need a separate `CupertinoPage` for those platforms in a Material app. Do not forget `ShellRoute.builder`: shell routes fall back to `NoTransitionPage` through the same check, so switch them to `pageBuilder` too. For a `StatefulShellRoute`, the same applies to its `pageBuilder`.

Then lock the behaviour in with a regression test, so the next go_router bump cannot remove transitions silently. This one passes with the router above:

```dart
// Flutter 3.44.8, go_router 18.1.4
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:repro/routes.dart';

void main() {
  testWidgets('routes get a MaterialPage, not NoTransitionPage', (tester) async {
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    expect(ModalRoute.of(tester.element(find.text('Home')))!.settings,
        isA<MaterialPage<void>>());

    router.go('/details/42');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // Mid-transition both pages are still in the tree.
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Details 42'), findsOneWidget);
    await tester.pumpAndSettle();
  });
}
```

## Trap 1: a MaterialPage from the wrong library ignores your page transitions theme

The pageBuilder workaround animates no matter which `MaterialPage` you return, which makes a subtle mistake easy. `MaterialPage` builds its transition from `Theme.of(context).pageTransitionsTheme`, and each library has its own `Theme` inherited widget. A `material_ui` page under an SDK `MaterialApp` (or the other way around) finds no theme of its own type and falls back to a default `ThemeData`, so your configured `PageTransitionsTheme` is skipped.

The test configured `OpenUpwardsPageTransitionsBuilder` for Android in each app's theme, returned each kind of page from `pageBuilder`, and recorded which transition widget wrapped the pushed page (results summarized from the test output):

```text
// Flutter 3.44.8, go_router 18.1.4, material_ui 1.2.0, test platform: android
SDK MaterialApp         | sdk.MaterialPage -> [_OpenUpwardsPageTransition]
SDK MaterialApp         | mui.MaterialPage -> [_FadeForwardsPageTransition]
material_ui MaterialApp | sdk.MaterialPage -> [_FadeForwardsPageTransition]
material_ui MaterialApp | mui.MaterialPage -> [_OpenUpwardsPageTransition]
```

`_FadeForwardsPageTransition` is the default Android transition, not the one the app asked for. If you set a custom transition per platform, for example a Cupertino slide on Android as covered in [migrating custom page transitions after the page transition builders reorganization](/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/), the mixed-library page quietly drops it.

`MaterialUiCompatibilityBridge`, the bridge the migration guide recommends for unmigrated dependencies, does not rescue this case either. In material_ui 1.2.0 and 1.11.1, its `_mapToLegacy` copies `platform`, colours, text theme and visual density into a legacy `ThemeData`, but not `pageTransitionsTheme`. With a `material_ui` app, the bridge in `MaterialApp.builder`, go_router 17.5.0 and an SDK `MaterialPage` from `pageBuilder`, the pushed page was still wrapped in `_FadeForwardsPageTransition`. And the bridge does nothing for detection: with plain `builder` routes the same setup still produced `NoTransitionPage<void>`, because the bridge is not a `MaterialApp`.

## Trap 2: Hero flights go straight instead of arcing

`RouteBuilder` also uses `isMaterialApp` to choose the `HeroController` it installs right above the `Navigator`. A detected Material app gets `MaterialApp.createMaterialHeroController()`, which flies heroes along a `MaterialRectArcTween`. A failed detection gets a plain `HeroController()`, whose flights use a straight `RectTween`. The test read `createRectTween` from the nearest non-null `HeroControllerScope` above the page (results summarized from the test output):

```text
// Flutter 3.44.8
go_router 18.1.4: SDK MaterialApp         -> null (straight RectTween)
go_router 18.1.4: material_ui MaterialApp -> MaterialRectArcTween
go_router 17.5.0: SDK MaterialApp         -> MaterialRectArcTween
go_router 17.5.0: material_ui MaterialApp -> null (straight RectTween)
```

With `builder` routes and a mismatch, Heroes do not fly at all, because a `NoTransitionPage` has no transition for the flight to follow. That is how [the first report](https://github.com/flutter/flutter/issues/191132) surfaced: a list-to-detail avatar stopped animating, which looks like a broken Hero tag rather than a routing problem. Switching to `pageBuilder` brings the flight back, but along a straight line, and you cannot override it from outside: go_router's own `HeroControllerScope` sits directly above its `Navigator`, so an outer scope never wins. The remaining lever is per widget, `Hero(createRectTween: (begin, end) => MaterialRectArcTween(begin: begin, end: end), ...)`, which does not reach widgets that create their own Hero, such as a `FloatingActionButton`. If arcing Heroes matter to you, that is a strong reason to take fix 1 or 2 rather than the pageBuilder workaround. The [Hero animation walkthrough](/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) covers `createRectTween` in more detail.

## Trap 3: the error page changes too

The same `else` branch swaps the default error screen. A detected Material app gets `MaterialErrorScreen`, a detected Cupertino app gets `CupertinoErrorScreen`, and a failed detection gets the unstyled `ErrorScreen`. If you rely on the default error page (no `errorBuilder` or `errorPageBuilder`), a mismatch also changes what users see for an unknown deep link. Setting `errorPageBuilder` explicitly, as shown in [setting up nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), removes the dependency on detection.

## Which combination you are in, at a glance

| App widget from | go_router 17.x (up to 17.5.0) | go_router 18.x (18.0.0 to 18.1.4) |
|---|---|---|
| `package:flutter/material.dart` | `MaterialPage`, works | `NoTransitionPage`, broken |
| `package:material_ui` | `NoTransitionPage`, broken | `MaterialPage`, works |
| `package:flutter/cupertino.dart` | `CupertinoPage`, works | `NoTransitionPage`, broken |
| `package:cupertino_ui` | `NoTransitionPage`, broken | `CupertinoPage`, works |
| Any, routes use `pageBuilder` | Your page, works | Your page, works |

The `material_ui` migration has a few other compile-time traps, which show up as baffling type errors rather than silent behaviour changes: [the `TextTheme` can't be assigned to `TextTheme?` error with google_fonts](/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/) and [`Undefined name 'awaitNotRequired'` on Flutter 3.44](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/) are worth reading before you run `dart fix`. If you are deciding whether to keep go_router at all, the [go_router vs auto_route vs Navigator 2.0 comparison](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) covers how each one chooses pages.

## Sources

- [flutter/flutter#191132: material_ui MaterialApp routes lose platform transitions](https://github.com/flutter/flutter/issues/191132) (go_router 17.5.0)
- [flutter/flutter#192761: go_router 18.0.0 drops platform transitions for apps using the SDK MaterialApp](https://github.com/flutter/flutter/issues/192761)
- [flutter/packages#12504](https://github.com/flutter/packages/pull/12504), the change released as go_router 18.0.0
- [go_router changelog](https://pub.dev/packages/go_router/changelog) and source of [`lib/src/builder.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/builder.dart) and [`lib/src/pages/material.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/pages/material.dart)
- [Migrate to standalone material_ui and cupertino_ui packages](https://docs.flutter.dev/release/breaking-changes/material-ui-and-cupertino-ui) (Flutter docs)
- [`package:material_ui`](https://pub.dev/packages/material_ui) and [`package:cupertino_ui`](https://pub.dev/packages/cupertino_ui) on pub.dev
