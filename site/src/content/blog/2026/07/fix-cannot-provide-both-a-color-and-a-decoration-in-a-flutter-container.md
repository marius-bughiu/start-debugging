---
title: "Fix: Cannot provide both a color and a decoration in a Flutter Container"
description: "Move the color inside the decoration: use decoration: BoxDecoration(color: ...) instead of passing both color and decoration to the same Container."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
---

The fix in one line: delete the `color:` argument on your `Container` and put that color inside the `BoxDecoration` instead, as `decoration: BoxDecoration(color: Colors.blue, ...)`. The assertion fires because `Container`'s `color` parameter is nothing more than a shorthand for `decoration: BoxDecoration(color: color)`, so passing both would give the widget two competing definitions of its background and Flutter refuses to guess which one wins.

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

This post is written against Flutter 3.x (tested on 3.44) and Dart 3.x. The `Container` assertion has read the same way since the 1.x days, so everything here applies cleanly across the entire 3.x line and back into 2.x. The check lives in `package:flutter/src/widgets/container.dart`; the line number in your stack trace may differ by a few between SDK versions, but the assertion expression `color == null || decoration == null` is stable.

## Why Container forbids color and decoration together

`Container` is a convenience widget. It does not paint anything itself; it composes a stack of simpler widgets (`Padding`, `DecoratedBox`, `ConstrainedBox`, `Transform`, and friends) based on which arguments you pass. The `color` argument is the smallest possible slice of that composition: when you set it, `Container` internally builds a `DecoratedBox` with a `BoxDecoration(color: color)`. That is the entire meaning of `color`. It is sugar.

`decoration` is the full-power version of the same thing. A `BoxDecoration` can carry a background color, a border, rounded corners, a gradient, a shadow, and a background image all at once. Because a `BoxDecoration` already has its own `color` field, letting you also pass a top-level `color` would create an ambiguous widget: which color paints, the one on the `Container` or the one on the `BoxDecoration`? Rather than silently pick a winner (and have half the community assume the opposite rule), the framework asserts at construction time and forces you to be explicit. The constructor contains a plain `assert(color == null || decoration == null, ...)`, which is why this only throws in debug and profile builds where assertions run.

There is a second, subtler reason in the framework's own words: a `decoration` can paint over the background color. A `BoxDecoration` with a `DecorationImage` or a gradient draws across the box's fill, so a separate `color` underneath would sometimes be visible and sometimes not, depending on the decoration's opacity. Collapsing both into one `BoxDecoration` removes that whole class of "why is my color not showing" confusion.

## The smallest repro that triggers it

Any `Container` that wants both a solid background and a border hits this immediately. This is the canonical case, because the natural first attempt is to reach for `color` for the fill and `decoration` for the border:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

Run it and the app never paints a frame. The assertion throws inside `Container`'s constructor, so the error surfaces the moment `build` runs, not later during layout. That timing is a useful signal: unlike a `RenderFlex overflowed` or a `RenderBox was not laid out` error, which happen during the layout phase, this one is a construction-time contract violation.

## The fix, in order of how often you need it

### Fix 1: move the color into the BoxDecoration

This is correct roughly every time. If you are passing a `decoration`, drop the `color` argument and set `BoxDecoration.color` instead:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

One `BoxDecoration` now owns the whole visual: fill, border, and corner radius. This is the shape you want for any card, chip, badge, or button background, because the moment you need a border or rounded corners you were always going to end up in a `BoxDecoration` anyway.

### Fix 2: if you only need a flat color, keep color and delete the decoration

If you reached for `decoration` only to add rounded corners or a border, that is deliberate and Fix 1 is right. But if the `decoration` crept in from a copy-paste and all you actually need is a solid fill with no border, gradient, or radius, do the opposite: keep the top-level `color` and delete the `decoration` entirely.

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

The `color` shorthand is not deprecated or discouraged for the flat-fill case. It reads cleaner than wrapping a single color in a `BoxDecoration`, and it produces the same `DecoratedBox` under the hood. Reach for the full `BoxDecoration` only when you need one of its extra features.

### Fix 3: drop Container entirely for a plain colored box

When your `Container` has no padding, no constraints beyond a size, and no transform, and you only want a rectangle of color, `ColoredBox` is the leaner widget and it never has this ambiguity because it takes a required `color` and no decoration:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` can be `const` when its child is `const`, which lets Flutter skip rebuilding and repainting it. That is a real, if small, win in a list of many static tiles. For anything with a border or radius, go back to Fix 1; `ColoredBox` cannot draw those.

## Where this actually bites in real code

### Theming a widget by spreading a shared decoration

Design systems often keep a shared `BoxDecoration` and then try to override just the color per instance:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

You cannot layer a top-level `color` on top of an existing `BoxDecoration`. Use `copyWith` on the decoration instead, which is exactly what it is for:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

If you are pulling colors from a Material 3 `ColorScheme` here, the roles (`surface`, `surfaceContainerHigh`, `primaryContainer`) matter for contrast in both light and dark mode; see [how to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) for which role to reach for.

### AnimatedContainer has the exact same rule

`AnimatedContainer` shares `Container`'s constructor contract, so the identical assertion fires there. The trap is worse because people animate a color by tweening the top-level `color` while a static `decoration` provides the border:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

Animate the color inside the `BoxDecoration`, and `AnimatedContainer` will interpolate the whole decoration for you, border and all:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` implements the lerp needed for the border and color to animate together, which the two-argument version could never do.

### A conditional that leaves both set

The nastiest version compiles fine and only throws on one branch. Someone adds a border conditionally but forgets to move the color:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

When `isHighlighted` is false, `decoration` is `null` and the assertion passes, so the code looks correct in every screenshot until a user highlights a row. Push the color into both branches (or into a single `BoxDecoration` built with a conditional border) so there is no state where both are non-null.

## Finding which Container is guilty in a large tree

The assertion message names the file and line inside `container.dart`, not your widget. To find your offending `Container`:

1. Read the stack trace below the assertion. The first frame in your own code (a file under `lib/`) is the `build` method that created the bad `Container`. Flutter prints "The relevant error-causing widget was" followed by your widget and its source location in most versions.
2. If the trace is unhelpful because the `Container` is built in a loop or a shared builder, grep your project for `color:` and `decoration:` appearing close together. The regex `Container\([^)]*color:[^)]*decoration:` catches most single-line cases; multi-line ones need a manual scan of the shared card or tile widget.
3. Because this throws at construction, hot reload surfaces it instantly. Add the border or decoration, save, and if the frame goes red you have the right widget on screen.

This construction-time behavior is the opposite of layout assertions like [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), which only appear once the layout pipeline runs and often point several widgets away from the real cause.

## Gotchas and lookalike errors

- **`BoxDecoration.color` versus `Container.color` paint order.** They are not identical in every case. `Container.color` paints behind the child but also behind any `decoration` were one allowed; `BoxDecoration.color` paints as part of the decoration, which sits behind `foregroundDecoration`. For a plain fill the result is the same pixel, but if you also use `foregroundDecoration` the layering matters.
- **`Ink` and `InkWell` splashes disappear over a colored Container.** If you gave a `Container` a `color` and then wrapped a child in `InkWell`, the ripple paints behind the `Container`'s color and vanishes. The fix is the same move: drop `Container.color` and use an `Ink` widget with a `decoration`, or a `Material` with a color, so the ink layer sits above the fill.
- **`The following assertion was thrown building` with a different message.** If your error mentions `Incorrect use of ParentDataWidget` rather than color and decoration, that is a separate layout-contract bug; see [Incorrect use of ParentDataWidget: Expanded must be inside Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).
- **Release builds hide it, they do not fix it.** Because the check is an `assert`, a release build strips it and paints using whichever argument the constructor stored. Do not ship on the assumption that "it works in release." It works by accident, and the next SDK bump can change which argument wins.
- **`DecoratedBox` throws the same conceptual error differently.** `DecoratedBox` has no `color` argument at all, only `decoration`, so you cannot hit this assertion there. If you were using `DecoratedBox` and wanted a color, it always goes in the `BoxDecoration`.

## Related

- [Fix: A RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) is the other assertion beginners hit first when building card and row layouts.
- [Fix: RenderBox was not laid out in Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) covers a layout-time error that, unlike this one, points away from the real cause.
- [Fix: Incorrect use of ParentDataWidget: Expanded must be placed inside Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) is a sibling construction-contract assertion worth recognizing.
- [How to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) explains which `ColorScheme` role to feed into your `BoxDecoration.color`.

## Sources

- [Container.new constructor -- Flutter API](https://api.flutter.dev/flutter/widgets/Container/Container.html), which documents the `color` shorthand and the "cannot provide both" rule verbatim.
- [BoxDecoration class reference](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html), the decoration that owns `color`, `border`, `borderRadius`, `gradient`, and `boxShadow`.
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484), the tracking issue discussing how the error message could be clearer.
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312), the original report showing the exact assertion and stack trace from `container.dart`.
