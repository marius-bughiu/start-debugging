---
title: "Fix: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "This error means an Expanded or Flexible is not a direct child of a Row, Column, or Flex. Move it directly under the flex widget, or drop Expanded if the parent is not a flex."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` means an `Expanded` (or `Flexible`) is not a direct child of a `Row`, `Column`, or `Flex`. Some other widget -- a `Container`, `SizedBox`, `Padding`, `Center`, `Stack`, or `Wrap` -- sits between them. Fix it by making `Expanded` the direct child of the flex, or by dropping `Expanded` entirely if the parent is not a flex. Tested on Flutter 3.x (3.44), Dart 3.x.

## The error in context

Flutter throws this during the build phase, as an assertion, before layout runs. The short summary line is the one people search for, but the full message in current Flutter tells you exactly which widget is wrong and what it is wrongly nested inside:

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

Two lines carry all the information. "wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" is the type mismatch. "The offending Expanded is currently placed inside a `SizedBox` widget" names the wrong parent by widget type. In older Flutter releases the whole thing collapses to the summary you probably typed into the search bar: `Expanded widgets must be placed inside Flex widgets`.

## Why a Flex parent is mandatory, not just recommended

`Expanded` does not paint anything. It is a `ParentDataWidget`: its entire job is to attach a piece of configuration to its child so the parent render object knows how to lay that child out. For `Expanded`, that configuration is a flex factor, and it lives in an object of type `FlexParentData`.

Here is the mechanism. A `Row`, `Column`, or `Flex` is backed by a `RenderFlex`. When `RenderFlex` adopts a child, it sets up a `FlexParentData` slot on that child to hold the flex value and the fit. `Expanded` walks up to its parent render object and calls `applyParentData`, which writes `flex` and `fit` into that slot. `RenderFlex` reads the slot during layout: children with a flex factor split the leftover main-axis space in proportion to their factors. That handshake is the only reason `Expanded` works.

Every other render object sets up a different `ParentData` type. A `SizedBox`, `Container`, or `Padding` gives its single child `BoxParentData`. A `Stack` gives children `StackParentData`. A `Wrap` gives children `WrapParentData`. None of those has a `flex` field, and `FlexParentData` cannot be written into a `BoxParentData` slot. So when `Expanded` tries to `applyParentData` on a non-flex parent, the framework's `debugIsValidRenderObject` check catches the type mismatch up front and throws, rather than silently ignoring the flex factor or crashing later during layout. The message is generated from the widget's `debugTypicalAncestorWidgetDescription`, which for `Expanded` is "Flex widgets" -- that is where the "must be placed inside Flex widgets" phrasing comes from.

This is a different failure from a [RenderFlex overflow](/2026/05/fix-renderflex-overflowed-in-flutter/), which happens when a `Row` or `Column` runs out of space at layout time. This one fires earlier, at build time, and it is a type error: the flex configuration has nowhere valid to land.

## The minimal repro

The smallest version is an `Expanded` wrapped in any single-child box widget:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` gives its child `BoxParentData`. `Expanded` wants to write `FlexParentData`. Build throws. The identical failure appears if you swap `SizedBox` for `Container`, `Padding`, `Center`, `Align`, `Card`, `Wrap`, or a `Stack` -- anything that is not a `Row`, `Column`, or `Flex`.

## Fix 1: make Expanded a direct child of the Row, Column, or Flex

If you do have a flex parent and an intervening widget snuck in, the fix is to reorder so `Expanded` sits directly under the flex. This is by far the most common case: someone wrapped a flex child in a `Padding` or `Container` for styling, and the `Expanded` ended up on the wrong side of it.

Wrong -- `Expanded` is inside the `Padding`, and `Padding` is a box:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

Right -- `Expanded` is the direct child of the `Column`, and the `Padding` goes inside it:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

The rule to internalize: `Expanded` must be the outermost widget in that slot of the `children` list. Everything you want to decorate, pad, or size goes inside its `child`, not around it.

## Fix 2: drop Expanded when the parent is not a flex at all

If there is genuinely no `Row`, `Column`, or `Flex` above the widget, then `Expanded` is the wrong tool and no amount of nesting will make it legal. You want a different way to fill space:

- **To fill the parent's width or height**, size the child directly. Use `SizedBox(width: double.infinity)`, `SizedBox.expand`, or `double.infinity` in a `Container`'s constraints:

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **To fill a fraction of the parent**, use `FractionallySizedBox`:

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **If you actually wanted proportional splitting**, you were reaching for `Expanded` for the right reason but forgot the flex parent. Introduce one. Wrap the group in a `Row` or `Column` and put the `Expanded` children directly inside it:

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

Choose by intent. If you only ever have one child, you do not need flex at all -- size the box. If you are dividing space between siblings, you need a real flex parent.

## Fix 3: watch for a RenderObjectWidget hiding in the path

`Expanded`'s contract is stricter than "somewhere under a Column". The docs state that the path from `Expanded` up to its enclosing `Row`, `Column`, or `Flex` must contain **only** `StatelessWidget`s or `StatefulWidget`s. The moment a `RenderObjectWidget` appears in that path, it becomes the parent that receives the parent data, and the mismatch throws.

This bites in two sneaky ways:

**A `Container` with certain properties inserts render widgets.** `Container` is a composition: give it `padding` and it wraps its child in a `Padding`; give it a `color` or `decoration` and it adds a `DecoratedBox`; give it `alignment` and it adds an `Align`. So `Container(padding: ..., child: Expanded(...))` puts a `Padding` (a `RenderObjectWidget`) directly above your `Expanded`, even though you never wrote `Padding`. That is the repro from Fix 1 in disguise.

**Your own custom `RenderObjectWidget` in the path.** If you have a bespoke render widget wrapping children before they reach the `Column`, the same rule applies. Custom `StatelessWidget` and `StatefulWidget` wrappers are fine; a custom `RenderObjectWidget` is not.

The takeaway: it is not enough for a `Flex` to be an ancestor. `Expanded` has to reach it through nothing but plain composition widgets.

## Gotchas and lookalikes

**`flex: 0` still throws.** It is tempting to think `Expanded(flex: 0)` is a no-op that the framework would let slide. It is not. The parent-data type check runs regardless of the flex value, so `Expanded(flex: 0)` inside a `Wrap` fails with exactly the same error, naming `WrapParentData` as the incompatible type. This was confirmed as intended behavior in [flutter/flutter issue 154950](https://github.com/flutter/flutter/issues/154950). If you want a child that participates in a `Wrap` at a fixed width, give it a `SizedBox`, not an `Expanded`.

**`Flexible` has the identical rule.** `Expanded` is just `Flexible` with `fit: FlexFit.tight`. `Flexible` is also a `ParentDataWidget<FlexParentData>`, so putting a `Flexible` inside a non-flex parent throws the same "Flexible widgets must be placed inside Flex widgets" error. Swapping `Expanded` for `Flexible` never fixes this error -- it only changes the widget name in the message.

**`Positioned` outside a `Stack` is the same shape of bug.** If you see `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets`, it is the exact same mechanism with different types: `Positioned` writes `StackParentData` and needs a `Stack` (backed by `RenderStack`) as its parent. The fix pattern is identical -- make it a direct child of a `Stack`, or use a non-positioned layout.

**A conditional or spread that yields an `Expanded` at the top level.** Building children with a helper, a `...[]` spread, or a ternary can accidentally hand an `Expanded` to a non-flex parent when the branch you did not test is taken. The error names the runtime parent, so trust "currently placed inside a X widget" over what the source looks like at a glance.

**The error only asserts in debug builds.** The `debugIsValidRenderObject` check is a debug-mode assertion. In a release build the assertion is compiled out, the flex data is silently dropped, and you get a subtly wrong layout instead of a crash -- which is worse to diagnose. Always resolve this in debug before shipping; do not assume a release build that "looks fine" is correct.

## Related

- [Fix: A RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) -- the other `Row`/`Column` error, thrown at layout time when flex children ask for more space than exists.
- [Fix: RenderBox was not laid out in Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- a layout-time assertion you often meet in the same scroll-and-flex plumbing.
- [Fix: A RenderViewport expected a RenderSliver in a Flutter CustomScrollView](/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) -- the same "wrong protocol" idea, but for slivers versus boxes instead of flex versus box parent data.
- [How to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- where `Expanded` is the correct answer, giving a `ListView` a bounded height inside a `Column`.

## Sources

- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- states that `Expanded` must be a descendant of `Row`, `Column`, or `Flex`, with only Stateless/Stateful widgets in the path.
- [ParentDataWidget class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html) -- `applyParentData`, `debugTypicalAncestorWidgetDescription`, and the validity check that generates this message.
- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html) -- the base class of `Expanded`, subject to the same flex-parent requirement.
- [flutter/flutter issue 154950](https://github.com/flutter/flutter/issues/154950) -- confirms the error still fires for `Expanded(flex: 0)` inside a non-flex parent by design.
