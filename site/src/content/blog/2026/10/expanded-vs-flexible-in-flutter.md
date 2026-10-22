---
title: "Expanded vs Flexible in Flutter: FlexFit.tight vs FlexFit.loose explained"
description: "Use Expanded when a child must fill its share of a Row or Column, and Flexible when it may be smaller than its share. Measured layouts on Flutter 3.44 show where the leftover space goes, why loose children never donate it to siblings, and when only Flexible survives unbounded constraints."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
---

**Short answer:** `Expanded` is literally `Flexible(fit: FlexFit.tight)`. Use `Expanded` when the child must fill its share of the `Row` or `Column` (lists, panels, anything with a background). Use `Flexible` (the default `FlexFit.loose`) when the child may be smaller than its share, the classic case being a `Text` that should truncate when long but hug its content when short. Both get the same maximum size; only `Expanded` forces the child to that size. Everything below was measured with `flutter test` on Flutter 3.44.8 / Dart 3.12.2.

The confusion is understandable, because in the most common layouts the two look identical. A `ListView` or a `Container` with no child wants all the space it can get, so wrapping it in either widget produces the same pixels. The difference only shows up when the child is happy being small, and that is exactly where people get a stretched chip, an icon shoved to the far edge of a row, or a gap they cannot explain.

## The comparison at a glance

| Behaviour (Flutter 3.44)                                    | `Expanded`                         | `Flexible` (default)                   |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Fit                                                         | `FlexFit.tight`                    | `FlexFit.loose`                        |
| Constraint passed on the main axis                          | min = max = share                  | min = 0, max = share                   |
| Child smaller than its share                                | stretched to the share             | keeps its own size                     |
| Unused part of the share                                    | none                               | becomes free space, not given to siblings |
| `mainAxisAlignment` has any effect                          | no (no free space left)            | yes                                    |
| `Row(mainAxisSize: MainAxisSize.min)` shrinks               | no, row takes the full width       | yes                                    |
| Inside an unbounded main axis (scroll view)                 | always an assertion                | allowed if `mainAxisSize: MainAxisSize.min` |
| Configurable `fit`                                          | no                                 | yes                                    |

If you only remember one row, remember the third: tight stretches, loose does not.

## What the framework actually does with the two fits

The source is short enough to quote. In `packages/flutter/lib/src/widgets/basic.dart` on 3.44.8:

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

Neither widget lays anything out. They are `ParentDataWidget`s that write `flex` and `fit` into the child's `FlexParentData`, which `RenderFlex` (the render object behind `Row`, `Column`, and `Flex`) reads during layout. That is also why both throw the same "must be placed inside Flex widgets" error when you put them under a non-flex parent.

`RenderFlex._computeSizes` in `rendering/flex.dart` runs in two passes:

1. Lay out every child with `flex == 0` (plain widgets) using their natural size and sum their main-axis extents.
2. Compute `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` **once**, then lay out each flex child with a maximum of `spacePerFlex * flex`. For `FlexFit.tight` the minimum equals that maximum. For `FlexFit.loose` the minimum is `0`.

The detail that matters is "once". The share is decided before any flexible child is measured. If a loose child uses less than its share, the remainder is not handed to its siblings. It becomes free space for `mainAxisAlignment`, which is the source of most "why is there a gap" questions.

## Measured: the same child under both fits

All numbers below come from widget tests that pin the `Row` to a 400 logical pixel wide box and read back `tester.getSize` and `tester.getTopLeft`. Here is the harness and the first case:

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

Output: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`. Both children were offered 200 pixels (400 split across a total flex of 2). The `SizedBox(width: 50)` under `Expanded` was overridden by the tight constraint and became 200 wide; under `Flexible` it kept its 50. The `width: 50` is a request, and a tight constraint from the parent always wins.

The full set of probes, same 400 px row:

| Layout (Flutter 3.44.8)                                                        | Result                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 and 50                                          |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 and 200, 150 px unused at the end                |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 and 40, 60 px unused                           |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300, identical to `Expanded`                        |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100, the loose fit changed nothing            |

The second row is the one to internalize. The 1000-pixel child was clamped to 200 even though its sibling only used 50, because the sibling's unused 150 was never redistributed. If you want "the small one takes what it needs and the big one gets the rest", the small one must not be flexible at all: make it a plain child, and only the big one `Expanded`.

The last row explains why so many people conclude "Flexible and Expanded are the same thing". A `Container` with no child, no width, and no alignment sizes itself to the largest size its constraints allow. Give it a loose maximum of 300 and it picks 300. The same is true of `ListView`, `TextField` (which fills its width), and anything else that expands by default. With greedy children, the fit is invisible.

## When to pick Expanded

- **A scrollable inside a `Column`.** `Column(children: [Header(), Expanded(child: ListView(...))])` is the canonical layout. The list needs a bounded height, and it should be exactly the remaining height so its scroll extent is right. This is the first fix in [the ListView-inside-a-Column guide](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/), and [the reason it beats `shrinkWrap` for long lists](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) is that the list keeps building its children lazily.
- **Panels that carry a background, border, or hit area.** A coloured sidebar and content area split 1:3 should use `Expanded(flex: 1)` and `Expanded(flex: 3)` so the colours run edge to edge, regardless of what the content measures.
- **Proportional grids built from `Row`s.** If three cells must line up with three cells in the next row, tight fits guarantee the same widths. Loose fits let each row drift with its content.
- **Pushing things apart.** `Spacer()` is `Expanded(flex: flex, child: SizedBox.shrink())`. In the probe, `SizedBox(w: 50)`, `Spacer()`, `SizedBox(w: 50)` puts the second box at x = 350, flush right.

## When to pick Flexible

- **Text that should truncate only when it has to.** This is the case that matters most in real apps. Compare a label followed by an icon:

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

Measured in a 400 px row inside a `Scaffold`, with `userName = 'Short'`: under `Flexible` the text is 71.25 px wide and the icon sits at x = 71.25, right next to the name. Swap in `Expanded` and the text becomes 376 px wide and the icon is pushed to x = 376, the far edge of the row. For a long name both versions cap the text at 376 px and show an ellipsis, so the overflow fix is the same, but only `Flexible` keeps the short case looking right. If you are here because of the yellow-and-black stripe, the [RenderFlex overflowed guide](/2026/05/fix-renderflex-overflowed-in-flutter/) covers the other causes.

- **Chips, badges, and buttons that should keep their natural size** but must not overflow on narrow screens or with large accessibility text. Tight fits stretch their hit target across the row.
- **When you want `mainAxisAlignment` to work.** With two loose children of 50 px and `MainAxisAlignment.spaceBetween`, the second child lands at x = 350. With two `Expanded` children the alignment is ignored and the second lands at x = 200, because a tight layout has zero free space to distribute.
- **Rows that size to their content.** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` measured 70 px wide. The same row with `Expanded` measured the full 400 px, because a tight child consumes all the space the parent offers, so there is nothing left for `MainAxisSize.min` to minimize. This bites people building a pill-shaped container that is supposed to wrap its label.

## The gotcha that picks for you: unbounded main axis

Put a `Column` inside a `SingleChildScrollView` (or a `Row` inside a horizontal `ListView`) and the flex receives an infinite main-axis constraint. `RenderFlex` cannot divide infinity, so in `_computeSizes` it sets `canFlex = false` and lays every child out as if it had no flex at all.

What happens next depends on the fit. The debug check `_debugCheckConstraints` throws if a child has a non-zero flex **and** either the flex uses `MainAxisSize.max` or the child is `FlexFit.tight`:

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

Both were verified in the probe: the `Expanded` variant produced the assertion, the `Flexible` variant laid out a 10 x 50 child with no exception. This matters for reusable widgets. If a component wraps part of itself in `Expanded`, it can never be placed in a scrollable column. If it uses `Flexible` and its column uses `MainAxisSize.min`, it degrades gracefully: bounded parent, it flexes; unbounded parent, it takes its natural size. Note that in the unbounded case the `Flexible` is effectively a no-op, so a greedy child under it (a `ListView`) will still throw its own "unbounded height" error.

## Smaller gotchas and variants

**`flex: 0` turns the widget off.** `RenderFlex` checks `flex > 0` before treating a child as flexible. `Flexible(flex: 0, ...)` lays out like a plain child. `Spacer` asserts `flex > 0` to stop you doing this accidentally.

**`Flexible(fit: FlexFit.tight)` and `Expanded` are interchangeable.** The probe produced identical sizes. Prefer `Expanded` for readability; reach for an explicit `fit` only when it is computed, for example `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)`.

**Cross axis is untouched.** Both widgets only constrain the main axis. If you want the child to fill the cross axis too, that is `crossAxisAlignment: CrossAxisAlignment.stretch` on the `Row` or `Column`, not a different flex widget.

**`spacing` comes out first.** Since Flutter 3.27, `Row` and `Column` have a `spacing` parameter. `_computeSizes` seeds the used space with `spacing * (childCount - 1)` before dividing, so gaps are subtracted before any flex share is computed.

**Do not chain them.** `Expanded(child: Flexible(...))` throws the ParentDataWidget error because the inner one's parent is not a flex. See [the "Expanded widgets must be placed inside Flex widgets" fix](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) for the full list of wrappers that cause it.

## The recommendation, with the context behind it

Default to `Expanded`. Most flexible children in real apps are scrollables, panels, or fields that want all the space anyway, and tight fits give you predictable, aligned layouts with no free-space surprises.

Switch to `Flexible` in exactly three situations: the child has a natural size you want to keep (text next to an icon, a chip), you need `mainAxisAlignment` or `MainAxisSize.min` to keep working, or you are writing a reusable widget that may land inside a scroll view. And when you catch yourself putting `Flexible` on two siblings expecting the small one to donate space to the big one, stop: make the small one a plain child and the big one `Expanded`, because `RenderFlex` never redistributes a loose child's unused share.

## Related

- [Fix "A RenderFlex overflowed by N pixels" in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) for the overflow cases where the choice between these two is the fix.
- [Why a ListView inside a Column throws an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) and the four ways to bound it.
- [shrinkWrap vs Expanded vs slivers for long lists](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) when the flexible child is a scrollable.
- [Fixing "Incorrect use of ParentDataWidget"](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) when `Expanded` or `Flexible` is not a direct flex child.

## Sources

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)
