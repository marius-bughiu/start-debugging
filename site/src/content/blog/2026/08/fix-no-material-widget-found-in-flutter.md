---
title: "Fix: No Material widget found in Flutter"
description: "Wrap the subtree in Material(type: MaterialType.transparency) or put the screen in a Scaffold. MaterialApp alone does not provide a Material ancestor, which is why TextField and InkWell assert."
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
---

`No Material widget found` means the widget you just built (`TextField`, `InkWell`, `ListTile`, `Chip`, `Switch`, `Slider`, and friends) walked up the tree looking for a `Material` ancestor and did not find one. The fastest safe fix is to wrap the subtree in `Material(type: MaterialType.transparency, child: ...)`, which changes nothing visually. The structural fix is to put the screen inside a `Scaffold`. Note that `MaterialApp` on its own does **not** provide a `Material`. Verified against Flutter 3.44 stable, Dart 3.x.

## The error in context

The assertion is thrown from the failing widget's `build` method, so the first line names the widget that could not find its ancestor:

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

There is a second wording you may hit instead, and it is a genuinely different problem:

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

That one means a `Material` does exist above you, but a `LookupBoundary` is deliberately blocking the walk. It has its own section below.

## Which widgets actually require a Material ancestor

This matters because the list is narrower than "everything in `package:flutter/material.dart`". Grepping `assert(debugCheckHasMaterial(context))` across `packages/flutter/lib/src/material/` on the Flutter 3.44 stable branch gives the real set:

- `InkWell`, `InkResponse` (via `InkResponse.debugCheckContext`) and `Ink`
- `TextField`
- `ListTile`
- `Chip`, `InputChip`, `ActionChip`, `ChoiceChip`, `FilterChip`
- `Checkbox`, `Radio`, `Switch`, `Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

Just as useful is what is *not* on the list. `ElevatedButton`, `FilledButton`, `OutlinedButton`, `TextButton`, `FloatingActionButton`, `Card`, and `Tooltip` do not assert, because each of them builds its own `Material` internally and then puts the ink surface underneath its own child. That is why a screen full of buttons works fine outside a `Scaffold` right up until you add one `TextField` and it explodes.

`IconButton` is a special case worth knowing. Its assert sits on the Material 2 code path only: `build` returns early through `_SelectableIconButton` when `theme.useMaterial3` is true, and the `assert(debugCheckHasMaterial(context))` comes after that return. Since `useMaterial3` has defaulted to `true` from Flutter 3.16 onward, a stock `IconButton` no longer needs a `Material` ancestor. Flip your theme back to `useMaterial3: false` and it starts asserting again.

## Why MaterialApp is not enough

This is the part that catches almost everyone, and it is not obvious from the name. `MaterialApp` gives you a `Theme`, `MaterialLocalizations`, a `Navigator`, a `ScaffoldMessenger`, and a `WidgetsApp`. It does not insert a `Material` anywhere. There is no `Material(` construction in `packages/flutter/lib/src/material/app.dart` at all.

The `Material` comes from `Scaffold`. Its state's `build` wraps the whole layout in one:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

The same is true of `Card`, `Dialog`, `Drawer`, and the sheet built by `showModalBottomSheet`: each constructs a `Material` around its child. That is exactly the list the error hint gives you, and it is the list because those are the widgets that actually do it.

## The minimal repro

Twelve lines, and it throws on the first frame:

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

Swap `TextField` for `ElevatedButton` and it renders. Swap it for `ListTile` and it throws again. The failing ingredient is never `MaterialApp`, it is the absence of a `Scaffold` (or any other `Material` carrier) between the app and the widget.

## Fix 1: put the screen inside a Scaffold

If the failing widget is part of a screen, this is the correct fix, not a workaround. You get the `Material`, plus the background color, app bar slot, safe-area handling, and keyboard insets that the widget was implicitly designed to sit on:

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

Reach for one of the other fixes only when a `Scaffold` genuinely does not belong: an overlay entry, a widget test, a fragment rendered outside the normal route tree.

## Fix 2: Material with MaterialType.transparency

When you need the ink surface but not the visuals, this is the fix that costs you nothing:

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

The type matters more than it looks. Two things change based on it, both visible in `Material`'s build method:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

A bare `Material(child: ...)` defaults to `MaterialType.canvas`, which paints an opaque `theme.canvasColor` rectangle over whatever was behind it and sets `absorbHitTest: true`, swallowing pointer events that used to pass through to widgets below. `MaterialType.transparency` paints nothing and absorbs nothing. If you are patching an existing layout, always start with `transparency` so you do not trade a crash for a silently broken gesture or a white box over your gradient.

One thing `transparency` does not opt you out of: `Material` always wraps its child in an `AnimatedDefaultTextStyle` using `widget.textStyle ?? Theme.of(context).textTheme.bodyMedium`. If unstyled `Text` inside the newly wrapped subtree suddenly changes size or color, that is why. Pass an explicit `textStyle`, or set the style on the `Text` widgets themselves.

## Fix 3: use a container widget that already carries a Material

Sometimes the right answer is neither `Scaffold` nor a raw `Material`, because you already wanted the container:

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`, `showModalBottomSheet`, and `Drawer` all give you a `Material` for free, so `ListTile` and `TextField` work inside them without a `Scaffold`. The failure mode to watch for is `showGeneralDialog`, whose `pageBuilder` returns your widget raw with no `Material` wrapper at all. Wrap it yourself, or use `Dialog`.

`Overlay` entries have the same shape of problem. An `OverlayEntry` builder is mounted as a child of the `Overlay`, not of your screen's `Scaffold`, so it does not inherit the `Scaffold`'s `Material` no matter how deep in the tree the code that inserted it lives.

## Fix 4: WidgetsApp users need MaterialApp

If your app root is `WidgetsApp` or `CupertinoApp` and you are pulling in Material widgets anyway, you get this error plus its sibling `No MaterialLocalizations found`. This was closed as invalid usage in [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843), and the maintainers are right: either move to `MaterialApp`, or add the `Material` and `Localizations` scopes yourself. `MaterialApp` is the cheaper answer for almost everyone.

## The LookupBoundary variant

The `within the closest LookupBoundary` wording means the walk was intercepted. `debugCheckHasMaterial` uses `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)`, not the plain element walk, and a `LookupBoundary` stops it dead even when a perfectly good `Material` sits above.

In framework code, the only place that inserts one is `view.dart`:

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

So if you are rendering into a second `FlutterView` through `ViewAnchor` (a tooltip in its own platform view, a secondary desktop window), the boundary is intentional: the content in that view is a separate render tree and must not silently depend on ancestors in the host view. The fix is to give the new view its own `Material` (or its own `Scaffold`) rather than trying to reach through the boundary. This is one of the sharper edges when you [enable multi-window support in a Flutter desktop app](/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

If you inserted a `LookupBoundary` yourself to isolate a subtree, the same rule applies: everything the subtree needs has to live inside it.

## Gotchas and lookalikes

**Debug throws, release does not.** `debugCheckHasMaterial` is wrapped in `assert(() { ... }())`, so it is compiled out of release builds entirely and the function just returns `true`. A `TextField` with no `Material` will render in `--release` and crash in debug, which is exactly the confusion behind issue 103843. Do not treat "it works in release" as evidence the tree is fine. The moment an ink effect actually fires, `Material.of(context)` runs, and that one throws in release too: "Material.of() was called with a context that does not contain a Material widget."

**The splash is invisible but there is no error.** Different bug, same neighborhood. Ink splashes are painted onto the `Material` itself, *under* everything drawn above it, so an `InkWell` wrapped in a `Container(color: ...)` paints its splash behind the container's opaque fill. Swap `Container(color: x)` for `Ink(color: x)` (or set the color on the `Material`), because `Ink` paints its decoration onto the parent `Material` so the splash lands on top. Related: [Cannot provide both a color and a decoration in a Flutter Container](/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/).

**Widget tests fail where the app works.** `tester.pumpWidget(const TextField())` throws for the same reason `runApp` does. Widget tests need the ancestors spelled out: `MaterialApp(home: Scaffold(body: TextField()))`, or at minimum `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))`. Missing `Directionality` and missing `MediaQuery` produce the same shape of error from `debugCheckHasDirectionality` and `MediaQuery.of`.

**Do not wrap the entire app in one Material.** It works, and it is a trap. A single app-level `Material` makes every ink splash in the app render on one surface, defeats per-screen background colors, and applies one `bodyMedium` default text style everywhere. Add the `Material` at the smallest scope that fixes the error.

**Nested Material changes which surface splashes land on.** `Material.of` resolves the *closest* ancestor, so an inner `Material` with a `borderRadius` or `shape` clips splashes to that shape. That is usually what you want for a custom card, and occasionally the reason a splash looks square when you expected it rounded.

**`No MaterialLocalizations found` is a different missing ancestor.** Same upward-walk mechanism, different scope, emitted by `debugCheckHasMaterialLocalizations`. Adding a `Material` will not fix it; adding a `MaterialApp` or a `Localizations` delegate will.

## Related

- [Fix: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) -- the same ancestor-lookup failure, one layer up, plus the `Builder` trick for getting a context below the widget you need.
- [Fix: Looking up a deactivated widget's ancestor is unsafe in Flutter](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- when the ancestor exists but the lookup happens at the wrong moment in the lifecycle.
- [Fix: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- another structural "wrong place in the widget tree" assertion Flutter catches during build.
- [How to enable multi-window support in a Flutter desktop app](/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/) -- where `LookupBoundary` starts blocking ancestor lookups in real apps.
- [How to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) -- the `canvasColor` and `scaffoldBackgroundColor` a `Material` picks up when you do not pass one.

## Sources

- [debugCheckHasMaterial, Flutter API reference](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html) -- the assertion itself, including the `LookupBoundary` branch and the exact hint text.
- [Material class, Flutter API reference](https://api.flutter.dev/flutter/material/Material-class.html) -- `MaterialType` values, clipping, elevation, and how ink features are attached.
- [Ink class, Flutter API reference](https://api.flutter.dev/flutter/material/Ink-class.html) -- why splashes are obscured by an opaque decoration drawn above the `Material`, and how `Ink` avoids it.
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843) -- the debug-only assertion confirmed by maintainers, closed as invalid usage of `WidgetsApp`.
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart) -- source for `debugCheckHasMaterial` and `debugCheckHasMaterialLocalizations`.
