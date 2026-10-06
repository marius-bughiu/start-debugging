---
title: "Fix: BoxConstraints forces an infinite height in Flutter"
description: "A widget asked for height: double.infinity inside a parent with no height limit, like a Column or ListView. Use Expanded, a finite height, LimitedBox, or SliverFillRemaining instead."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
---

`BoxConstraints forces an infinite height` means some widget asked to be exactly `double.infinity` pixels tall, and its parent had no height limit to clamp that request to. The usual culprits are `SizedBox(height: double.infinity)`, `Container(height: double.infinity)`, `SizedBox.expand`, or `BoxConstraints.expand()` placed directly inside a `Column`, `ListView`, or `SingleChildScrollView`. The fix is to stop asking for "infinite" where nothing is finite: use `Expanded` inside a `Column`, give the box a real number, wrap it in `LimitedBox`, or switch to `SliverFillRemaining` when you want "fill the rest of the screen, but still scroll". Everything below was reproduced with Flutter 3.44.8 (stable) and Dart 3.12.2.

The confusing part is that `height: double.infinity` is a perfectly normal idiom. It works most of the time. It only blows up when the nearest ancestor that sets the height constraint says "pick any height you like", and that is exactly what columns and scroll views say.

## The error in context

This is the first block Flutter prints. I trimmed the stack trace, which runs to about 100 frames of `RenderProxyBoxMixin.performLayout`:

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

Three lines carry all the information you need:

- **`h=Infinity`** in the offending constraints. That is a *tight* infinite height: minimum and maximum are both infinity. Nothing can satisfy that.
- **`RenderConstrainedBox.performLayout`** is the function that computed it. `RenderConstrainedBox` is the render object behind `SizedBox`, `ConstrainedBox`, and the sizing part of `Container`. So the culprit is almost always one of those three.
- **"The relevant error-causing widget was"** gives you the file and line of that widget. Click it in your IDE.

Below that block you will see a cascade of `RenderBox was not laid out` assertions, one per ancestor, plus a `Scaffold` one. Those are fallout. Fix the first error and they all disappear. If you landed here from that cascade, the [walkthrough of RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) explains why it piles up like that.

The sibling message `BoxConstraints forces an infinite width.` is the same bug rotated 90 degrees, and `BoxConstraints forces an infinite width and infinite height.` is both at once. Everything in this post applies to them with width and height swapped.

## Why this happens

Flutter layout is one rule: constraints go down, sizes go up, the parent sets the position. Every parent hands its child a `BoxConstraints` with a min and max for width and height.

When you write `SizedBox(height: double.infinity)`, you are not setting the height to infinity. You are asking for tight constraints of `minHeight: infinity, maxHeight: infinity`, and `RenderConstrainedBox` then reconciles that request with what its own parent allowed, using `BoxConstraints.enforce`:

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

That clamp is why the idiom normally works. Inside a `Scaffold` body the parent says `0 <= h <= 600`, so infinity clamps to 600 and the box fills the screen. But a `Column` gives each non-flex child `0 <= h <= Infinity` on its main axis, and a vertical `ListView` or `SingleChildScrollView` does the same. Clamping infinity to a maximum of infinity leaves infinity. The resulting constraints are passed to the child's `layout()`, which runs `debugAssertIsValid(isAppliedConstraint: true)`, sees an infinite minimum, and throws.

So the rule to remember: **`double.infinity` means "as big as my parent allows". It is only safe when the parent allows something finite.**

## A minimal repro you can paste into a fresh app

Each of these three bodies throws the error on Flutter 3.44.8. I ran them as widget tests inside `MaterialApp(home: Scaffold(body: ...))`:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

The offending constraints differ slightly: the `Column` repro reports `BoxConstraints(0.0<=w<=800.0, h=Infinity)` because a column's cross axis is loose, while the `ListView` and `SizedBox.expand` repros report `BoxConstraints(w=800.0, h=Infinity)`. Same bug, same fix.

One detail that misleads people: if the `SizedBox` has **no child**, you do not get this message at all. You get `RenderConstrainedBox object was given an infinite size during layout`, because there is no child to call `layout()` on and the box tries to size itself to infinity instead. Same cause, different wording.

## Fix, in detail

Pick the fix by asking what you actually wanted the infinite height to do.

### 1. "Fill the remaining space in the Column": use Expanded

This is the most common intent. Inside a `Column`, the way to say "take whatever is left" is a flex child, not an infinite size:

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

In my test with an 800x600 surface, the red box came out at `Size(800.0, 580.0)`: the full height minus the header line. `Expanded` works because the `Column` lays out flex children last, after it knows how much space the fixed children used, and passes them a tight, finite height.

This only works when the `Column` itself has a bounded height. If that `Column` sits inside a `SingleChildScrollView`, `Expanded` swaps this error for `RenderFlex children have non-zero flex but incoming height constraints are unbounded`. That is the same problem one level up, and fixes 3 and 4 handle it.

### 2. "I just want it tall": give it a finite number

If the box is inside a scroll view, it will scroll, so "fill the screen" is usually not what you meant. Give it a real height, or derive one from the screen:

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

That produced a `Size(800.0, 300.0)` box on a 600-pixel-tall surface. Prefer `MediaQuery.sizeOf(context)` over `MediaQuery.of(context).size`: it only rebuilds when the size changes, not on every `MediaQuery` change such as keyboard insets.

If the widget is reusable and you do not know whether it will land in a bounded or unbounded parent, use `LimitedBox`. It does nothing when the parent is bounded, and caps the maximum when the parent is not:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

Inside the `ListView`, that container laid out at `Size(800.0, 200.0)` with no error. Put the same widget in a bounded parent and it fills the parent instead. This is the pattern the official "Understanding constraints" guide recommends for exactly this situation.

### 3. "Fill the screen, but scroll if the content is taller": SliverFillRemaining

This is the login-form case: a column that should stretch to the bottom of the viewport so a button can sit at the bottom, but scroll on small phones or when the keyboard is open. `SliverFillRemaining` with `hasScrollBody: false` is the purpose-built widget:

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

The red box got `Size(800.0, 500.0)`: exactly the viewport minus the 100-pixel header. `hasScrollBody: false` tells the sliver that its child is not itself a scrollable, so it sizes the child to at least the remaining extent, and to the child's own height if that is larger. If the child is a `ListView` or other scroll view, leave `hasScrollBody` at its default of `true`.

### 4. The same thing without slivers: LayoutBuilder plus ConstrainedBox

If you are not ready to move a screen to `CustomScrollView`, the `SingleChildScrollView` documentation describes a pattern that reads the viewport height once and turns it into a *minimum* instead of a tight infinite size:

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

The `LayoutBuilder` sits outside the scroll view, so `viewport.maxHeight` is finite (600 here). `ConstrainedBox` gives the column a floor of 600 but no ceiling, and `IntrinsicHeight` gives the `Column` a bounded height so `Expanded` is legal. My test produced a 560-pixel red box between the two text lines. `IntrinsicHeight` costs an extra layout pass over its subtree, which is fine for a form and wrong for a long list. For long content, go with fix 3 or the options in [shrinkWrap vs Expanded vs slivers](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

### 5. "Match the height of the row": IntrinsicHeight plus stretch

A very common source of this error inside lists is a coloured side bar or vertical divider meant to be as tall as its neighbour:

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

The `Row` passes its own unbounded vertical constraint to the bar. Ask the row to measure its tallest child first, then stretch everything to match:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

No `height` on the bar at all: `CrossAxisAlignment.stretch` gives it a tight height equal to the row, and `IntrinsicHeight` makes that height finite. One `IntrinsicHeight` per list item is cheap enough for typical lists.

## Gotchas and lookalike errors

- **`double.maxFinite` is not a fix.** Swapping `double.infinity` for `double.maxFinite` silences the assertion, but in my test the box laid out at `Size(0.0, 1.7976931348623157e+308)`. You have built a box taller than the universe, and anything below it is unreachable. If you find this "fix" in a code review, it is the same bug, hidden.
- **The check is debug-only.** `debugAssertIsValid` runs inside an `assert`, so release builds skip it and you get a grey area or missing content instead of a red screen. Always reproduce layout bugs in debug mode.
- **A horizontal `ListView` is fine.** `ListView(scrollDirection: Axis.horizontal)` gives children a bounded *height* (its own), so `height: double.infinity` inside it clamps correctly: my test got `Size(100.0, 600.0)`. In that list, it is `width: double.infinity` that breaks.
- **`Vertical viewport was given unbounded height`** is the inverse situation: a scrollable placed inside a `Column`, rather than an infinite box placed inside a scrollable. The fixes overlap, and the [ListView inside a Column guide](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) covers that one in depth.
- **`TextField` inside a `Row`** produces `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width` as its first error on Flutter 3.44.8, not the `BoxConstraints` message. Wrap the field in `Expanded` or a fixed-width `SizedBox`.
- **`IntrinsicHeight` around a `ListView`** does not throw this error. It throws `RenderViewport does not support returning intrinsic dimensions`, because a lazy viewport refuses to measure all of its children. Never wrap a scrollable in an intrinsic widget.
- **`UnconstrainedBox`** removes its parent's constraints entirely, so any infinite child inside it throws this error even in a bounded screen. Put a `LimitedBox` between them, or drop the `UnconstrainedBox`.
- **A `Column` that overflows instead of throwing** is a different problem: the content is finite but too tall. See the [RenderFlex overflowed guide](/2026/05/fix-renderflex-overflowed-in-flutter/).

## Finding the culprit in a large widget tree

When the "relevant error-causing widget" points at a shared component, open Flutter DevTools, select the widget in the Widget Inspector, and look at the constraints shown in the Layout Explorer. Walk up the tree until you find the first ancestor whose height constraint is `Infinity`: that is the `Column`, `ListView`, `Row`, or `UnconstrainedBox` that removed the limit. The fix goes either on that ancestor (bound it) or on the child (stop asking for infinity). Searching your code for `double.infinity`, `.expand(`, and `BoxConstraints.expand` usually finds the candidate in under a minute.

## Related

- [Fix: RenderBox was not laid out in Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), the cascade that follows this error.
- [How to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).
- [shrinkWrap vs Expanded vs slivers for long lists in Flutter](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).
- [Fix: A RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/).
- [Fix: RenderViewport expected a RenderSliver in a CustomScrollView](/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/), if you hit it while moving to `SliverFillRemaining`.

## Sources

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (Flutter docs), including the `LimitedBox` and `UnconstrainedBox` examples.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (Flutter docs).
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) and [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (API reference).
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), the "Centering, spacing, or aligning fixed-height content" section.
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) and [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (API reference).
- `packages/flutter/lib/src/rendering/box.dart` and `proxy_box.dart` in the Flutter 3.44.8 SDK, read locally.
