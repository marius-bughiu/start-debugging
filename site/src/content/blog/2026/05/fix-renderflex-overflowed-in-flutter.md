---
title: "Fix: A RenderFlex overflowed by N pixels in Flutter"
description: "The fix in 30 seconds: wrap the offending child in Expanded or Flexible. Then read the rest to learn why Row and Column do not clip, what unbounded constraints actually mean, and which fix is right for each layout."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
---

The fix in one breath: wrap the child that grew too wide (or too tall) in an `Expanded` or `Flexible`, set `mainAxisSize: MainAxisSize.min` on the surrounding `Row` or `Column`, or wrap the whole thing in a `SingleChildScrollView` if the content really is supposed to scroll. The yellow and black stripe is not a rendering bug, it is Flutter telling you that an unbounded child inside a `Row`, `Column`, or `Flex` asked for more space than its parent could give it.

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

This guide is written against Flutter 3.27.1, Dart 3.11, and Material 3 widgets as shipped in the stable channel. Everything in the post applies cleanly back to Flutter 3.10 and forward through the 3.x line. The widget API for `Row`, `Column`, `Expanded`, `Flexible`, and `Flex` has not changed in years; the underlying `RenderFlex` is in `package:flutter/src/rendering/flex.dart` and that is where the assertion is raised.

## Why Row and Column refuse to clip silently

Flutter does layout in a single pass. Each parent passes a `BoxConstraints` object down to its children, the children pick a size that satisfies those constraints, and the parent positions them. Most widgets accept whatever size their child chooses, but `Row`, `Column`, and the underlying `Flex` widget are different: they lay out non-flexible children first using their intrinsic sizes, then divide the remaining space among `Expanded` and `Flexible` children. If the non-flexible children together exceed the main-axis space the parent gave the flex, there is nothing to divide and the layout is over budget.

`RenderFlex` could clip the overflow silently, but that would hide layout bugs that only show up on the smallest device in your fleet. So Flutter prints the assertion in debug mode, paints the striped warning rectangle on the overflowing edge, and keeps rendering. In release mode the stripe is gone but the layout is still wrong: text gets cut off, tap targets disappear off-screen, and screen readers read content that the user cannot see. This is documented in the [Common Flutter errors page](https://docs.flutter.dev/testing/common-errors) and matches the source comment at the top of [flex.dart in the Flutter SDK](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart).

## A minimal repro you can paste into a fresh app

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

This is the canonical case. The outer `Row` has bounded width from the `Scaffold`, the `Icon` and the `SizedBox` are non-flexible and small, but the inner `Column` is also non-flexible and wraps a `Text` that wants to be as wide as the entire paragraph laid out on one line. Run this on any phone-sized layout and you get the overflow on the right edge.

## Pick the right fix: Expanded, Flexible, or scrollable

There are three correct fixes and they are not interchangeable.

### Fix 1: wrap the greedy child in `Expanded`

Use this when the child should take all the remaining main-axis space. In the repro, the `Column` is the greedy child:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` is `Flexible` with `flex: 1` and `fit: FlexFit.tight`. Tight means the child must fill the assigned space exactly. Inside a `Row`, that gives the inner `Text` a bounded width, which lets the text engine wrap onto multiple lines. The overflow is gone because the `Text`'s intrinsic width is no longer feeding back into the `Row`'s width calculation.

This is the right fix 80% of the time. Use it whenever you have a leading icon plus a body of text in a row, or a header plus a scrolling body in a column. See the [Expanded class reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) for the formal contract.

### Fix 2: wrap a child in `Flexible` when it may be smaller than its share

`Flexible` defaults to `fit: FlexFit.loose`, which means "you can use up to this much space but you are not required to fill it." Use it when you have two children that should share the remaining space proportionally but neither has to fill its allocation. The classic case is two equally important `TextField`s side by side that should each take half the row:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

If you used `Expanded` here the fields would still split the row 50/50, but if one of them was a `Chip` instead of a `TextField`, `Expanded` would stretch the chip's hit target to fill the full width, which looks broken. `Flexible` with the chip's natural width keeps the visual size correct and still solves the overflow.

The rule of thumb: `Expanded` for "fill what is left," `Flexible` for "you can grow up to what is left." Picking the wrong one usually does not cause an overflow, just an ugly stretched widget.

### Fix 3: make the cross axis scrollable when the content genuinely does not fit

Overflows on the bottom of a `Column` inside a phone screen are almost always a sign that the user is supposed to scroll. The fix is not `Expanded`, it is to put the `Column` inside a `SingleChildScrollView` (or replace it with a `ListView`):

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

For a long list with a known item count and homogenous children, prefer `ListView.builder`, which lazily builds only the items on screen. A `SingleChildScrollView` with a `Column` builds every child every frame, which is fine for a settings page with eight rows but ruinous for a thousand-row feed. The [Flutter scrolling docs](https://docs.flutter.dev/ui/layout/scrolling) draw this line clearly.

## Cause-by-cause: the four ways this error sneaks in

### A `Text` widget inside a `Row` with no bounded width

The most common cause, shown in the repro above. Long strings, long product names, and translated UI strings (German is famously wider than English) all blow up `Row`s that worked on the developer's machine. Always wrap user-supplied or localized text in `Expanded` or `Flexible` when it sits in a `Row`. If the text is supposed to truncate rather than wrap, add `overflow: TextOverflow.ellipsis` and `maxLines: 1` on the `Text` widget itself:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### Unbounded main axis: a `Column` inside a `Column`, or a `Row` inside a `Row`

If a `Column` is the child of another `Column`, the inner one receives unbounded height. Anything inside it that asks for "as much as I want" gets infinity, which RenderFlex then complains about. The fix is to wrap the inner `Column` in `Expanded`, or to set `mainAxisSize: MainAxisSize.min` and put the whole thing inside a scrollable.

The same applies to a `Row` inside a `Row`, a `ListView` inside a `Column`, or any combination where the main axis is unbounded. Read [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) once and the rest of these stop looking surprising; it explains the "constraints go down, sizes go up, parent sets position" mantra that the entire layout system runs on. The same constraint propagation also drives jank on resize storms, which we cover in [profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

### Hard-coded `width` or `height` from a SizedBox or Container

A `SizedBox(width: 400)` inside a phone-width `Row` will overflow on the right by `400 - rowWidth + remaining children` pixels. This is the one case where the fix is not `Expanded` but "stop hard-coding the width." Use a layout that adapts: `Expanded`, `Flexible`, `FractionallySizedBox(widthFactor: 0.5)`, or compute the size from `MediaQuery.sizeOf(context)`.

The same applies to images. An `Image.network` without a `width` constraint reports its intrinsic size, which can be 2000 pixels for a server-side asset. Either give the `Image` a bounded width (`Image.network(url, width: 64)`) or wrap it in an `Expanded`.

### Localization, font scaling, and accessibility text sizes

A `Row` that fits perfectly at the default font scale will overflow at 1.4x or 2.0x text scale. This is the bug that ships to the App Store and gets a one-star review from a user with large fonts turned on. Test every screen with `MediaQuery` overrides at the accessible scales:

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` replaces the older `textScaleFactor` API as of Flutter 3.16 and is the supported way to test text scaling. If the layout overflows under this `MediaQuery` wrapper, it will overflow on real devices and the fix is the same: `Expanded`, `Flexible`, or scrollable.

## Debugging which widget is overflowing

The assertion always names a widget and a source location, but the location points at the `Row` or `Column` that overflowed, not at the child causing the trouble. Three tools narrow it down:

1. The yellow-and-black stripe in debug mode tells you the edge (right, bottom, etc.), which already constrains the search.
2. Toggle "Debug Paint" in the Flutter Inspector (also available as `debugPaintSizeEnabled = true;` set in `main`) to see every render box's outline. The greedy child usually visibly extends past the parent.
3. Use the Inspector's widget selection mode and click the offending area on the simulator. The selected widget's `RenderObject` panel shows its size and constraints. Compare those to the parent.

For tooling that goes deeper, the same DevTools session that you use for performance work supports layout debugging in the Layout Explorer tab. If you are not familiar with that workflow, the post on [profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) walks through opening DevTools in profile mode against a real device.

## Gotchas and lookalike errors

- `Vertical viewport was given unbounded height` is the sibling error you get when a `ListView` lives inside a `Column` without an `Expanded`. The fix is the same shape: bound the child or make the parent scrollable. Do not "fix" it by setting `shrinkWrap: true` on the `ListView`; that disables lazy rendering and recreates the original overflow at higher scroll positions.
- `RenderBox was not laid out` means a `RenderFlex` overflow assertion threw earlier and the layout pipeline never got to compute paint geometry. Scroll up in the error log to the first overflow message; that is the real bug.
- `BoxConstraints forces an infinite width` raised by `Text` means the `Text` is inside something giving it an unbounded main axis, usually a `Row` inside a horizontal `ListView`. Wrap the `Text` in a fixed-width container or use `Flexible`.
- `A RenderFlex overflowed by Infinity pixels` is the unbounded-constraint variant. The fix is never "make the number smaller", it is "give the parent a bounded constraint", typically by adding `Expanded` higher up the tree.
- Suppressing the warning with `clipBehavior: Clip.hardEdge` on the `Row` or `Column` makes the stripe go away but leaves the underlying layout bug. Reach for clipping only when you have proven the overflow is intentional (e.g. a deliberately-cropped marquee).

## Related

- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) covers DevTools setup, which doubles as your fastest layout-debugger.
- [How to set the accent color in a Flutter app with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) is where most beginner overflow issues actually start, since switching to M3 widgets changes intrinsic sizes.
- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) becomes relevant once you start hiding rows on smaller form factors.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) matters because the exact pixel count in the overflow message changes between SDK versions when text metrics shift.

## Sources

- [Common Flutter errors -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors), the official Flutter docs section that defines the error and the canonical fix.
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), the layout-protocol explanation behind every flex layout decision in this post.
- [Expanded class reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html), the API doc that pins `Expanded` to `Flexible(flex: 1, fit: FlexFit.tight)`.
- [Flexible class reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html), the API doc that explains `FlexFit.loose` vs `FlexFit.tight`.
- [Row class reference](https://api.flutter.dev/flutter/widgets/Row-class.html) and [Column class reference](https://api.flutter.dev/flutter/widgets/Column-class.html), which describe the main-axis sizing algorithm verbatim.
- [flex.dart at tag 3.27.1](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart), the source where the overflow assertion is raised.
