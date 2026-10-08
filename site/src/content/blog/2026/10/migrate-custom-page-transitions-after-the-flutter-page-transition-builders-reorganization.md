---
title: "Migrate custom page transitions after the Flutter page transition builders reorganization (Flutter 3.44 to 3.47)"
description: "Flutter moved PageTransitionsBuilder and two built-in builders into the widgets layer and CupertinoPageTransitionsBuilder out of Material. What actually breaks (one import, with a misleading 'Not a constant expression' error), what dart fix does and gets wrong for material_ui projects, and how to rewrite custom builders and routes so they no longer depend on Material at all."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
---

For most apps this is a five-minute migration with exactly one source-breaking change: since Flutter 3.44, `CupertinoPageTransitionsBuilder` lives in the Cupertino library, so any file that imports only `package:flutter/material.dart` (or `package:material_ui/material_ui.dart`) and puts that builder into a `PageTransitionsTheme` stops compiling. Add the Cupertino import and you are done. The rest of the reorganization, which moved the `PageTransitionsBuilder` base class plus `FadeUpwardsPageTransitionsBuilder` and `OpenUpwardsPageTransitionsBuilder` into `package:flutter/widgets.dart` in Flutter 3.38 and 3.41, is non-breaking, but it is the part worth acting on: your custom builders can now drop their Material dependency entirely, which is what keeps them working when you move to the standalone design packages. Everything below was compiled and tested on Flutter 3.44.8 with Dart 3.12.2, and checked against the current stable, Flutter 3.47.6, with [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0 and [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2.

## Why the builders were moved

`PageTransitionsBuilder` started life as a Material class because `PageTransitionsTheme` and `MaterialPageRoute` were its only consumers. That made no sense for a Cupertino app, or for a team with its own design system built on `WidgetsApp`: to reuse a transition object, you had to import Material. Flutter's [issue #172929](https://github.com/flutter/flutter/issues/172929) ("Move platform specific page transitions outside of Material and Cupertino") tracked untangling that, as part of the larger effort to ship Material and Cupertino as separate packages.

The concrete outcomes:

- **Custom builders no longer need Material.** A `PageTransitionsBuilder` subclass can import only `package:flutter/widgets.dart` and be used by a hand-written `PageRoute`, a `WidgetsApp`, a `CupertinoApp`, or `PageTransitionsTheme`.
- **Cupertino apps get the iOS builder without pulling in Material.** `CupertinoPageTransitionsBuilder` now sits next to `CupertinoPageRoute` in `cupertino/route.dart`.
- **Builders survive the `material_ui` migration.** Because the base class lives in the widgets layer, which is not moving out of the SDK, a builder written against `widgets.dart` is the same type for the in-SDK `PageTransitionsTheme` and for the one in `material_ui`.

## What breaks

| Area | Change | Landed in stable | Severity |
| ---- | ------ | ---------------- | -------- |
| `PageTransitionsBuilder` | Moved from Material to `widgets.dart` ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | none, Material re-exports widgets |
| `FadeUpwardsPageTransitionsBuilder` | Moved to `widgets.dart` ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | none |
| `OpenUpwardsPageTransitionsBuilder` | Moved to `widgets.dart` ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | none |
| `CupertinoPageTransitionsBuilder` | Moved from Material to `cupertino.dart` ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | high for Material-only files, one import fixes it |
| `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder`, `PredictiveBackPageTransitionsBuilder`, `PageTransitionsTheme` | Unchanged, still Material | n/a | none |

The first three rows are invisible to a Material app because `material.dart` does `export 'package:flutter/widgets.dart'`. A file that writes `extends PageTransitionsBuilder` with only a Material import resolves the class through that re-export, exactly as before. The official [breaking change page](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders) lists `FadeUpwardsPageTransitionsBuilder` and `OpenUpwardsPageTransitionsBuilder` under "Material" for the same reason: from a Material import, that is where they appear to come from.

## Pre-flight checklist

- Know which Flutter you are on: `flutter --version`. The break needs 3.44 or later. 3.47.x is current stable.
- Find every reference before you touch anything:

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- Note whether the project is on the SDK libraries (`package:flutter/material.dart`) or the standalone packages (`package:material_ui/material_ui.dart`). The fix is the same idea, but the import line differs, and `dart fix` gets one of them wrong (see step 3).
- Check your path and git dependencies too. A package that references `CupertinoPageTransitionsBuilder` with only a Material import breaks your build in the same way, and you cannot fix it from your app.

## Migration steps

1. **Upgrade and reproduce the failure.** Move to the target SDK and run the analyzer, which gives a much clearer message than the compiler:

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   Take this `ThemeData` from a typical app, which compiled fine on 3.41:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 -- fails to compile
   import 'package:flutter/material.dart';

   final ThemeData theme = ThemeData(
     pageTransitionsTheme: const PageTransitionsTheme(
       builders: <TargetPlatform, PageTransitionsBuilder>{
         TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
         TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
         TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
       },
     ),
   );
   ```

   `flutter analyze` reports the real cause, `undefined_method`: "The method 'CupertinoPageTransitionsBuilder' isn't defined", plus `invalid_constant` and `non_constant_map_value` noise for each entry. Verify: you see one `undefined_method` per `CupertinoPageTransitionsBuilder` usage and no other new errors.

2. **Add the Cupertino import to each affected file.** On the SDK libraries:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   On the standalone packages:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   `material_ui` already depends on `cupertino_ui`, but importing a transitive dependency trips the `depend_on_referenced_packages` lint, so add it explicitly with `flutter pub add cupertino_ui`. Verify: `flutter analyze` is clean for those files.

3. **Or let `dart fix` do it, then check the result.** Both libraries ship a data-driven fix for this move (the `replacedBy` entry in `fix_material.yaml`):

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   On an SDK-libraries project this inserts `import 'package:flutter/cupertino.dart';` and nothing else, which is correct. On a `material_ui` 1.6.0 project, the fix data still points at `package:flutter/cupertino.dart`, the frozen SDK copy, not at `cupertino_ui`. Your code compiles, because the SDK builder extends the same widgets-layer base class, but you have just reintroduced an SDK design library import into a project you migrated away from it. Replace that line with the `cupertino_ui` import by hand. Verify: `grep -rn "package:flutter/cupertino.dart" lib` returns nothing on a migrated project.

4. **Retarget custom builders at the widgets layer.** A builder that only composes `SlideTransition`, `FadeTransition`, `ScaleTransition` and curves has no reason to import Material any more:

   ```dart
   // Flutter 3.44+, Dart 3.12 -- no Material import needed
   import 'package:flutter/widgets.dart';

   class FadeSlidePageTransitionsBuilder extends PageTransitionsBuilder {
     const FadeSlidePageTransitionsBuilder();

     @override
     Duration get transitionDuration => const Duration(milliseconds: 250);

     @override
     Widget buildTransitions<T>(
       PageRoute<T> route,
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) {
       final Animation<Offset> position = animation.drive(
         Tween<Offset>(begin: const Offset(0.0, 0.08), end: Offset.zero)
             .chain(CurveTween(curve: Curves.easeOutCubic)),
       );
       return FadeTransition(
         opacity: animation,
         child: SlideTransition(position: position, child: child),
       );
     }
   }
   ```

   The same class still drops into a Material theme unchanged, because `PageTransitionsTheme.builders` is typed against this exact base class. Verify: the file's only Flutter import is `widgets.dart` and `flutter analyze` is clean.

5. **Replace `PageRouteBuilder` boilerplate with a route that delegates to a builder.** This is the pattern the reorganization was designed for: one route class, any transition, no Material:

   ```dart
   // Flutter 3.44+, Dart 3.12
   import 'package:flutter/widgets.dart';

   class BuilderPageRoute<T> extends PageRoute<T> {
     BuilderPageRoute({
       required this.builder,
       this.transitionsBuilder = const FadeSlidePageTransitionsBuilder(),
       super.settings,
     });

     final WidgetBuilder builder;
     final PageTransitionsBuilder transitionsBuilder;

     @override
     Duration get transitionDuration => transitionsBuilder.transitionDuration;

     @override
     Duration get reverseTransitionDuration =>
         transitionsBuilder.reverseTransitionDuration;

     @override
     DelegatedTransitionBuilder? get delegatedTransition =>
         transitionsBuilder.delegatedTransition;

     @override
     Color? get barrierColor => null;

     @override
     String? get barrierLabel => null;

     @override
     bool get maintainState => true;

     @override
     Widget buildPage(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
     ) => builder(context);

     @override
     Widget buildTransitions(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) => transitionsBuilder.buildTransitions<T>(
       this,
       context,
       animation,
       secondaryAnimation,
       child,
     );
   }
   ```

   Forwarding `transitionDuration`, `reverseTransitionDuration` and `delegatedTransition` matters. The [official sample](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html) hardcodes 300 ms, which silently ignores the duration the builder declares, and without `delegatedTransition` a `CupertinoPageTransitionsBuilder` passed to this route animates the incoming page but leaves the previous page frozen instead of sliding it left. Verify with a widget test (next section).

6. **Plug the route into whatever app widget you use.** For a `WidgetsApp`-based design system, pass it as `pageRouteBuilder`:

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   In a Material app, keep using `PageTransitionsTheme` for the default and push `BuilderPageRoute` only where a screen needs a different transition. Verify: navigating to a pushed screen shows the new animation, and `flutter analyze` is clean.

## Verification

Do not trust your eyes on a 250 ms animation. Pump the route halfway and assert on the transition widget:

```dart
// Flutter 3.44.8, flutter_test
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/transitions.dart';

void main() {
  testWidgets('BuilderPageRoute uses the builder duration', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: navigator,
      color: const Color(0xFF000000),
      pageRouteBuilder: <T>(RouteSettings s, WidgetBuilder b) =>
          BuilderPageRoute<T>(builder: b, settings: s),
      home: const Text('home', textDirection: TextDirection.ltr),
    ));

    navigator.currentState!.push(BuilderPageRoute<void>(
      builder: (_) => const Text('second', textDirection: TextDirection.ltr),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 125));

    final fade = tester.widget<FadeTransition>(find
        .ancestor(of: find.text('second'), matching: find.byType(FadeTransition))
        .first);
    expect(fade.opacity.value, 0.5);

    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
  });
}
```

On Flutter 3.44.8 this passes with opacity exactly `0.5` at 125 ms, which proves the route picked up the builder's 250 ms duration. If someone hardcodes 300 ms again, the value drops to about `0.42` and the test fails. Beyond that:

- `flutter analyze` reports no `undefined_method` or `undefined_hidden_name` diagnostics.
- `flutter test` passes, including golden tests that capture mid-transition frames, if you have any.
- On an iOS simulator, swipe back from the left edge on a screen that uses `CupertinoPageTransitionsBuilder` and confirm the previous page moves with the gesture.

## Rollback plan

The code changes are additive: an extra import and a few classes that no longer need Material. All of them compile on 3.41 too, except that on 3.41 `CupertinoPageTransitionsBuilder` resolves through the Material import, so the added `cupertino.dart` import is merely redundant. Rolling back the SDK with `flutter downgrade` or a pinned version in CI does not require reverting any of this. The one thing that cannot go back below 3.38 is a builder that imports only `widgets.dart`, since the base class was not there yet.

## Gotchas

**The compiler error points at the wrong problem.** Inside a `const` map, which is how almost every `PageTransitionsTheme` is written, the front end does not say the name is undefined. `flutter build` and `flutter test` print only:

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

People delete `const`, which turns it into "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'", and then go looking for a method. Run `flutter analyze` first; it shows the `undefined_method` diagnostic alongside the constant noise.

**A partial `builders` map does not merge with the defaults.** Passing `builders:` replaces the whole default map, and missing platforms fall back at runtime to `CupertinoPageTransitionsBuilder` on iOS only and `ZoomPageTransitionsBuilder` everywhere else, macOS included. If you only list Android and iOS, macOS gets the zoom transition. While you are in this file anyway, list every platform you ship.

**Mixing the SDK and package Cupertino imports in one file.** On a `material_ui` project, a file that imports both `package:flutter/cupertino.dart` (left behind by `dart fix`) and `package:cupertino_ui/cupertino_ui.dart` gets `ambiguous_import` errors for every Cupertino name. Keep exactly one.

**Stale `hide` clauses.** Some codebases wrote `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;` to avoid a clash with a local class of the same name. On 3.44+ that name no longer exists in the Material namespace, and the analyzer flags `undefined_hidden_name`. Delete the clause.

**Third-party builders keep working.** `SharedAxisPageTransitionsBuilder` from [`animations`](https://pub.dev/packages/animations) and similar classes extend the base class through their own Material import, which re-exports the widgets-layer type, so they still slot into your theme. Only packages that themselves reference `CupertinoPageTransitionsBuilder` with a Material-only import break, and those need a package release, not a change in your app.

**Subclassing a Material builder still needs Material.** `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder` and the predictive back builders stayed in Material. If your custom builder extends one of them to tweak a duration, it keeps its Material (or `material_ui`) import.

## Related

- The import change here is one slice of the bigger move covered in [migrating Flutter Material and Cupertino imports to the material_ui and cupertino_ui packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- For the release that started the decoupling, see [Flutter 3.44 splitting Material and Cupertino into packages](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Another 3.44 compile error with the same root cause: [fixing "Undefined name 'awaitNotRequired'" with material_ui and cupertino_ui](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).
- If your custom transition is really a shared element, [a Hero animation between two screens](/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) may be the better tool.
- Routers that build their own pages, such as go_router's `CustomTransitionPage`, are compared in [go_router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Sources

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), Flutter breaking changes.
- [`PageTransitionsBuilder` API reference](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html).
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), the tracking issue.
- PRs [#174321](https://github.com/flutter/flutter/pull/174321), [#175560](https://github.com/flutter/flutter/pull/175560), [#177080](https://github.com/flutter/flutter/pull/177080) and [#179776](https://github.com/flutter/flutter/pull/179776).
- [Data-driven fixes](https://dart.dev/tools/fix) in the Dart docs.
