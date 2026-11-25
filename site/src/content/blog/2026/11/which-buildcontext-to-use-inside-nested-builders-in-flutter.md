---
title: "Which BuildContext should I use inside nested builders like ValueListenableBuilder in Flutter?"
description: "Use the innermost context you have: the builder's own context for .of() lookups, mounted checks, and navigation. Widget tests on Flutter 3.44.8 show where outer and inner contexts differ: theme overrides, nested Navigators, rebuild scope, and a mounted guard the lint does not catch."
pubDate: 2026-11-25
tags:
  - "flutter"
  - "dart"
  - "buildcontext"
  - "widgets"
---

Inside a `ValueListenableBuilder`, `Builder`, `LayoutBuilder` or any other builder callback, use the context that callback hands you (call it `innerContext`) for `Theme.of`, `Navigator.of`, `GoRouter.of`, `mounted` checks and anything else that happens inside that callback. In the common case both contexts find the same ancestors and the result is identical, but the inner one is never wrong while the outer one is wrong in three specific situations: when a widget between the two overrides the thing you look up (a `Theme`, a nested `Navigator`, a `Scaffold`), when you want a dependency to rebuild only the builder instead of the whole `build` method, and when you check `mounted` after an `await` and then use a different context than the one you checked. Everything below was measured with widget tests on Flutter 3.44.8 stable, Dart 3.12.2, `flutter_lints` 6.0.0.

## What a BuildContext actually is

A `BuildContext` is the `Element` that owns a widget's spot in the tree. The `context` parameter of your `build` method is your widget's element. The `innerContext` parameter of a `ValueListenableBuilder` builder is the `ValueListenableBuilder`'s own element, which is a descendant of yours. In a `State`, `this.context` and the `build` parameter are the same object: a `State` probe printing `identical(context, this.context)` from `build` printed `true`. So the question in [the Stack Overflow thread that prompted this post](https://stackoverflow.com/questions/80016546) has really only two candidates: your widget's element and the builder's element.

Every `.of(context)` call walks up from the element you pass. The [BuildContext API docs](https://api.flutter.dev/flutter/widgets/BuildContext-class.html) spell out the consequence: the context in a build method belongs to the widget that owns the method, not to the widgets it returns, and the context passed to `Builder.builder` "will be that of the `Builder` itself". That single fact explains all of the differences below. If nothing interesting sits between the two elements, both walks find the same ancestor. If something does, only the inner walk sees it.

Two details decide whether the choice matters for performance as well as correctness:

- `Theme.of`, `MediaQuery.of`, `MediaQuery.sizeOf` and most other `.of` methods on inherited data call `dependOnInheritedWidgetOfExactType`, which registers the element you passed as a dependent. When the inherited value changes, **that** element rebuilds.
- `Navigator.of`, `Scaffold.of` and similar "find a `State`" lookups use `findAncestorStateOfType`, which registers nothing. They never cause a rebuild, so for them only correctness matters.

## The test setup

The probes use the shape from the original question: a `StatelessWidget` whose `build` returns a `ValueListenableBuilder`, with counters to record how often each level builds.

```dart
// Flutter 3.44.8 (stable), Dart 3.12.2
import 'package:flutter/material.dart';

int outerBuilds = 0;
int innerBuilds = 0;
final isLoading = ValueNotifier<bool>(false);

class OuterRead extends StatelessWidget {
  const OuterRead({super.key});

  @override
  Widget build(BuildContext context) {
    outerBuilds++;
    return ValueListenableBuilder<bool>(
      valueListenable: isLoading,
      builder: (innerContext, loading, _) {
        innerBuilds++;
        final color = Theme.of(context).colorScheme.secondary; // OUTER context
        return ColoredBox(color: color, child: const SizedBox(key: Key('box')));
      },
    );
  }
}

// InnerRead is identical except for one line:
//   final color = Theme.of(innerContext).colorScheme.secondary; // INNER context
```

A `ThemeSwitcher` stateful widget wraps the probe in a `Theme` and swaps the seed color from blue to red on demand. The probe is a `const` instance, so the only way it can rebuild is through a dependency it registered. Each test resets the counters after the first frame, triggers one change, pumps one frame, and prints the counts. The full test file is reproduced in the "Reproducing the numbers" section at the end.

## Rebuild scope: the outer context drags the whole build method along

Results of flipping the theme once:

| Probe | Lookup | `build` runs | builder runs | Color updated |
| --- | --- | --- | --- | --- |
| `OuterRead` | `Theme.of(context)` inside the builder | 1 | 1 | yes |
| `InnerRead` | `Theme.of(innerContext)` inside the builder | 0 | 1 | yes |

Both are correct. The difference is who registered the dependency. `Theme.of(context)` runs during the builder callback, but the dependency is recorded on the element you passed, which is the outer one. When the theme changes, Flutter rebuilds the outer widget, which creates a new `ValueListenableBuilder` with a new closure, which then rebuilds the builder too. With `innerContext`, only the builder's element is a dependent, so only the builder runs.

Flipping `isLoading` itself rebuilds only the builder (`build` 0, builder 1) regardless of which context you used, because that path is driven by the `ValueListenable`, not by an inherited dependency.

The same thing shows up with `MediaQuery`, where it actually costs something because the soft keyboard changes `viewInsets` on every animation frame. Changing `viewInsets.bottom` from 0 to 300 with a fixed size:

| Lookup | `build` runs | builder runs |
| --- | --- | --- |
| `MediaQuery.of(context).size` in `build` | 1 | 1 |
| `MediaQuery.sizeOf(context)` in `build` | 0 | 0 |
| `MediaQuery.sizeOf(innerContext)` in the builder | 0 | 0 |

The aspect-specific [`MediaQuery.sizeOf`](https://api.flutter.dev/flutter/widgets/MediaQuery/sizeOf.html) matters more here than which context you pass: it only rebuilds when the size changes. But the theme table shows the general rule. The element you pass to a dependency-registering `.of` is the element that will rebuild, so passing the innermost context keeps rebuilds as small as possible. If you have to read a large `InheritedWidget` such as `Theme` and only a small subtree uses it, do the read inside a builder with its context. For a wider look at measuring this kind of waste, see [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

The flip side: if you read `Theme.of(context)` at the top of `build` (as the question does on its first line) and pass the result down, that is also fine. The outer widget rebuilds on theme changes either way in that case, and you avoid a second lookup. The waste only appears when the outer `build` does not otherwise need the value.

## Correctness: something between the two contexts overrides the lookup

When a `Theme` sits between the outer widget and the builder, the two contexts see different themes:

```dart
// Flutter 3.44.8 (stable), Dart 3.12.2
MaterialApp(
  theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue)),
  home: Builder(builder: (context) {
    return Theme(
      data: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.red)),
      child: ValueListenableBuilder<bool>(
        valueListenable: isLoading,
        builder: (innerContext, _, __) {
          final outer = Theme.of(context).colorScheme.primary;      // blue-seeded
          final inner = Theme.of(innerContext).colorScheme.primary; // red-seeded
          return const SizedBox();
        },
      ),
    );
  }),
);
```

The test printed two different colors (`outer=Color(... red: 0.2118, green: 0.3804, blue: 0.5569 ...)`, `inner=Color(... red: 0.5647, green: 0.2902, blue: 0.2588 ...)`, `same=false`). The widget you are building is red-themed, so the outer read is simply the wrong answer. This is the same mechanism behind the classic [`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold`](/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) error: the outer context sits above the `Scaffold` that your own `build` method created.

Navigation behaves the same way. With a nested `Navigator` between the two contexts, `Navigator.of(context)` and `Navigator.of(innerContext)` returned different `NavigatorState` objects (`identical` printed `false`). The outer one is the app's root navigator; the inner one is the nested navigator the button is actually inside. Pushing or popping with the outer context from inside a nested flow (a tab with its own stack, a bottom sheet with its own `Navigator`, a `go_router` `ShellRoute`) operates on the wrong stack. An app normally has one `GoRouter`, so `GoRouter.of` is less sensitive (this was not tested here), but `Navigator.of`, `Scaffold.of`, `DefaultTabController.of`, `Form.of` and `Theme.of` all depend on what sits in between.

In the exact snippet from the question nothing sits between `build` and `ValueListenableBuilder` except a `Column`, so both contexts return the same theme and router today. The point of preferring `innerContext` is that the code stays correct when someone later wraps the builder in a `Theme`, a `Scaffold`, or a nested `Navigator`.

## The mounted check: which element can disappear

After an `await`, you must check `mounted` before touching a context, because the element may have been unmounted while you waited. (The general patterns are in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).) With two contexts in play, the questions are which one can disappear and which one you should check.

The inner element is a descendant of the outer one. So if the outer is unmounted, the inner is too, but not the other way around. A probe that removed only the `ValueListenableBuilder` (by toggling a flag in a parent builder) printed:

```text
G after removal: outer.mounted=true inner.mounted=false
```

That makes `innerContext.mounted` the stricter and therefore the correct check when you then use `innerContext`. Checking the outer context and using the inner one is a real bug. This handler, attached to a button inside a builder that gets removed while the `await` is pending, passes the outer check and then crashes:

```dart
// Flutter 3.44.8 (stable), Dart 3.12.2
onPressed: () async {
  await doSomeAsyncWork();
  if (!context.mounted) return;        // checks the OUTER element: still mounted
  Navigator.of(innerContext).pop();    // uses the INNER element: already unmounted
},
```

In the widget test the `Navigator.of(innerContext)` call threw `_TypeError: Null check operator used on a null value`. The builder's element is a `StatefulElement` whose `State` is cleared on unmount, and `Navigator.of` dereferences it. That is a crash the guard was supposed to prevent.

### The lint does not catch the mismatch

The [`use_build_context_synchronously`](https://dart.dev/tools/linter-rules/use_build_context_synchronously) docs say that for a local or parameter context, that context's `mounted` property must be checked. The implementation is looser than the wording. A probe file with four button handlers, analyzed with `flutter analyze` on Dart 3.12.2 and `flutter_lints` 6.0.0:

| Handler after `await` | Lint result |
| --- | --- |
| `if (!context.mounted) return;` then `Navigator.of(innerContext)` | no issue |
| `if (!innerContext.mounted) return;` then `Navigator.of(context)` | no issue |
| `if (!innerContext.mounted) return;` then `Navigator.of(innerContext)` | no issue |
| no guard, then `Navigator.of(innerContext)` | `use_build_context_synchronously` |

Any `mounted` check satisfies the analyzer, regardless of which context it was on. The first row is exactly the crash above, and the analyzer is silent about it. Review rule: the identifier before `.mounted` and the identifier passed to `.of()` must be the same.

### Mounted does not mean "the button is still there"

A second subtlety from the question's code: `innerContext` belongs to the `ValueListenableBuilder`, not to the `FilledButton`. When the handler sets `isLoading.value = true`, the builder swaps the button for a `CircularProgressIndicator`. A probe that captured both contexts after that swap printed:

```text
F after swap: innerContext.mounted=true buttonContext.mounted=false
```

So `if (!innerContext.mounted) return;` passes even though the button that started the work is gone. That is usually what you want, because you still need a live context to navigate after the work finishes. If you instead extract the button into its own widget and use its context, the guard will bail out as soon as the loading state hides the button, and the navigation silently never happens. Pick the context whose lifetime matches the action: for "navigate after the async work completes", use a context that outlives the loading state, which in this layout is the builder's.

## The concrete rule

1. Inside a builder callback, pass the builder's context to every `.of()` call. It sees every override between you and the root, and it limits rebuilds to the builder.
2. Read inherited values with the outer `context` at the top of `build` only when the outer `build` uses them anyway; pass the values down instead of re-looking them up.
3. After an `await`, check `mounted` on the same identifier you then use. The lint will not enforce this.
4. Choose the context whose lifetime matches the action. A context on a widget your own loading state removes will fail the `mounted` check and drop the action.
5. In a `State`, `context` and `this.context` are the same element; the `build` parameter is not a third option.

Following these, the question's code is correct as written: `Theme.of(innerContext)`, `innerContext.mounted`, and `SomeGoRoute().go(innerContext)` all refer to the same element, and that element outlives the button swap. If a lookup ever needs to happen during build in a way that triggers a state change, keep [setState or markNeedsBuild called during build](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) in mind, and for reading custom theme values from deep inside builders, [ThemeExtension design tokens](/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/) work with the same `Theme.of(innerContext)` call.

## Reproducing the numbers

Environment: macOS, Flutter 3.44.8 stable, Dart 3.12.2, `flutter_lints` 6.0.0, a fresh `flutter create -e` project. Run with `flutter test`; each probe prints one line with `debugPrint`. Output from the run used for this post:

```text
A outer-read theme flip: outer=1 inner=1 colorChanged=true
B inner-read theme flip: outer=0 inner=1 colorChanged=true
C value flip: outer=0 inner=1
D override: ... same=false
E navigator: same=false
F after swap: innerContext.mounted=true buttonContext.mounted=false
G after removal: outer.mounted=true inner.mounted=false
H identical(context, this.context)=true
I MediaQuery.of(outer) keyboard: outer=1 inner=1
I MediaQuery.sizeOf(outer) keyboard: outer=0 inner=0
I MediaQuery.sizeOf(inner) keyboard: outer=0 inner=0
K caught: _TypeError: Null check operator used on a null value
```

The core of probes A and B, which you can drop into any `flutter test` file next to the `OuterRead` and `InnerRead` widgets above:

```dart
// Flutter 3.44.8 (stable), Dart 3.12.2
class ThemeSwitcher extends StatefulWidget {
  const ThemeSwitcher({super.key, required this.child});
  final Widget child;
  @override
  State<ThemeSwitcher> createState() => ThemeSwitcherState();
}

class ThemeSwitcherState extends State<ThemeSwitcher> {
  Color seed = Colors.blue;
  void flip() => setState(() => seed = Colors.red);
  @override
  Widget build(BuildContext context) => Theme(
        data: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed)),
        child: widget.child,
      );
}

void main() {
  testWidgets('theme change, outer vs inner read', (t) async {
    final key = GlobalKey<ThemeSwitcherState>();
    await t.pumpWidget(MaterialApp(
        home: ThemeSwitcher(key: key, child: const OuterRead())));
    outerBuilds = innerBuilds = 0;
    key.currentState!.flip();
    await t.pump();
    debugPrint('outer=$outerBuilds inner=$innerBuilds'); // OuterRead: 1 / 1
  });                                                     // InnerRead: 0 / 1
}
```

The removal probe (K) nests a `ValueListenableBuilder<int>` inside a `ValueListenableBuilder<bool>` that returns a `SizedBox` when its flag is false, taps the button, flips the flag, completes a `Completer` the handler is awaiting, and catches what `Navigator.of(innerContext)` throws.

## Sources

- [BuildContext class, Flutter API docs](https://api.flutter.dev/flutter/widgets/BuildContext-class.html)
- [BuildContext.mounted](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html)
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html)
- [ValueListenableBuilder class](https://api.flutter.dev/flutter/widgets/ValueListenableBuilder-class.html)
- [MediaQuery.sizeOf](https://api.flutter.dev/flutter/widgets/MediaQuery/sizeOf.html)
- [use_build_context_synchronously lint rule](https://dart.dev/tools/linter-rules/use_build_context_synchronously)
- [Stack Overflow: In a Widget build method, which context is the right one to refer to?](https://stackoverflow.com/questions/80016546)
