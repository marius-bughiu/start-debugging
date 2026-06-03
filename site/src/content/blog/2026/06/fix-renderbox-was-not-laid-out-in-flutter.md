---
title: "Fix: RenderBox was not laid out in Flutter"
description: "RenderBox was not laid out is almost always a secondary error. Find the first layout assertion above it, usually a scrollable given unbounded constraints, and fix that."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
---

`RenderBox was not laid out` means Flutter tried to paint or hit-test a render box whose size was never computed. It is almost always a follow-on error: an earlier layout assertion aborted `performLayout` for part of the tree, and this message is just the wreckage. The real fix is to scroll up to the first error in the console, which is usually a scrollable (`ListView`, `GridView`, `SingleChildScrollView`) given unbounded constraints on its scroll axis. Bound that widget with `Expanded`, a fixed size, or `shrinkWrap` and this disappears. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

The assertion that throws is `hasSize` in `package:flutter/src/rendering/box.dart`. A `RenderBox` only gets a size during its `performLayout` pass. If layout never ran successfully for that box, asking for `.size` (which paint and hit-testing both do) trips the guard. So the message is accurate but unhelpful on its own: it names the victim, not the culprit.

## The error in context

The console block looks like this. The exact widget name and hex IDs change, but the shape is constant:

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

Two details matter. First, the named render object (`RenderShrinkWrappingViewport`, `RenderPadding`, `RenderRepaintBoundary`, whatever) tells you which subtree failed to lay out. Second, and more important, this is rarely the only exception. In debug mode Flutter prints the first failure and then keeps trying to render, which produces a cascade of these `hasSize` assertions. The message you act on is the one at the top of the cascade, not the one your eye lands on.

## Why this happens

A `RenderBox` has a size only after `performLayout` assigns one. Three situations leave a box sizeless:

The box was given constraints it cannot satisfy, so its own `performLayout` threw. The classic case is a scrollable that received an unbounded constraint on its scroll axis. A vertical `ListView` needs a bounded height to know how much viewport to render; give it infinite height and it throws `Vertical viewport was given unbounded height`, layout aborts, and every ancestor that later tries to read its size reports `RenderBox was not laid out`.

A parent painted or hit-tested a child without laying it out first. This is the custom `RenderObject` bug: you wrote a render object whose `paint` reads `child.size` but whose `performLayout` forgot to call `child.layout(...)`. The child never got a size.

Someone read `.size` outside the layout phase. Reading `context.size` or `renderBox.size` during `build`, `initState`, or a synchronous callback, before the first frame has laid the widget out, hits the same assertion. The size simply does not exist yet.

The unifying rule is the Flutter layout contract: constraints go down, sizes come back up, and a box's size is valid only between the end of its `performLayout` and the next `markNeedsLayout`. Read more in the official [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) page, which is the single most useful document for every layout error in Flutter.

## A minimal repro you can paste into a fresh app

The most common trigger by far: a `ListView` placed directly inside a `Column`. The `Column` gives its children unbounded height on the main axis, the `ListView` wants a bounded height, and layout fails.

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

Run it and the first console error is `Vertical viewport was given unbounded height`. The `RenderBox was not laid out` assertions underneath it are the consequence, not the cause. The fix is to bound the `ListView`.

## Fix, in detail

The fixes are ranked by how often they are the right answer. Pick based on what the sizeless box actually needs.

### 1. Give a scrollable a bounded size with Expanded (recommended)

When a scrollable lives inside a `Column` or `Row` and should fill the leftover space, wrap it in `Expanded`. `Expanded` hands the child a tight, bounded constraint on the main axis, which is exactly what the viewport needs:

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

This keeps the `ListView` lazy: it builds only the rows currently on screen and scrolls the rest, which is what you want for any list that can grow. This is the correct fix for a feed, a search-results list, or any scrollable region with a header above it.

### 2. Use shrinkWrap when the list is short and should size to its content

If the list is genuinely small and finite (a handful of settings rows, a fixed menu) and you want it to take only as much height as its content, set `shrinkWrap: true`. That tells the `ListView` to measure its children and report their combined height instead of demanding a bounded viewport:

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

The trade-off is real: `shrinkWrap` lays out every child up front, defeating the lazy rendering that makes `ListView` cheap. Use it only for short, bounded lists. For anything that can grow to dozens of items, go back to fix 1. Adding `physics: NeverScrollableScrollPhysics()` stops the inner list from scrolling independently, which is usually what you want when the outer `Column` is the scroll surface.

### 3. Give the box an explicit bounded constraint

Sometimes the right answer is a concrete size. A `SizedBox` with a fixed height, or a `ConstrainedBox` with a max height, gives the scrollable a bound to work with:

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

A horizontal `ListView` inside a `Column` is the mirror image of the repro: the `Column` bounds width but leaves height unbounded, and the horizontal viewport needs a bounded height. A fixed `height` solves it cleanly. Use `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))` instead when the content may be shorter than the cap.

### 4. Lay out the child before reading its size in a custom RenderObject

If you wrote a custom `RenderObject` (or a `RenderBox` subclass), the assertion is telling you that `performLayout` accessed a child's size before laying it out. Always call `child.layout(...)` before reading `child.size`:

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

The `parentUsesSize: true` flag is required when the parent's own size depends on the child. Omit it and Flutter may skip relayout when the child changes, which produces stale layouts that look like this same error intermittently. The contract is documented on the [RenderBox.size API page](https://api.flutter.dev/flutter/rendering/RenderBox/size.html): the size is only valid during and after `performLayout`, and reading it from a parent requires `parentUsesSize: true` at `layout` time.

### 5. Defer a size read to after the first frame

If you need a widget's rendered size in Dart (to position an overlay, size a sibling, or feed a measurement back into state), do not read `context.size` during `build`. The render box has not been laid out yet. Read it after the frame:

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

For measuring during layout rather than after it, reach for `LayoutBuilder` (which hands you the parent constraints) or a `RenderObject` with `parentUsesSize: true`, not a post-frame size read. The post-frame approach is for the "I just need the final pixels once" case.

## Gotchas and lookalike errors

- `Vertical viewport was given unbounded height` and `Horizontal viewport was given unbounded width` are the primary errors that *cause* most `RenderBox was not laid out` cascades. If you see either above the `hasSize` assertion, fix that one and the rest vanish. The fix is fixes 1 through 3 above.
- `A RenderFlex overflowed by N pixels` is a different failure: the flex laid out fine but its children exceeded the available space. That paints a stripe rather than aborting layout. See [the RenderFlex overflow guide](/2026/05/fix-renderflex-overflowed-in-flutter/) for that one; it is not the same as a sizeless box.
- `BoxConstraints forces an infinite height` thrown by `IntrinsicHeight` or `IntrinsicWidth` wrapped around a scrollable. Intrinsic widgets do a speculative layout pass that scrollables refuse to participate in. Remove the `IntrinsicHeight`, or bound the scrollable directly with a `SizedBox`.
- A `TabBarView`, `PageView`, or nested `ListView` inside another scrollable hits the same unbounded-constraint wall. Wrap the inner scrollable in an `Expanded` (if the outer is a flex) or give it a fixed height, and set `shrinkWrap` only when the inner list is short.
- Reading `renderBox.size` from a `GlobalKey` immediately after `setState` returns the *previous* frame's size, or throws if the widget has not been laid out yet at all. Always gate these reads behind `addPostFrameCallback` and a `mounted` check, the same discipline that prevents the disposal crashes covered in [the controller-disposal guide](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- In release mode the assertion is compiled out, so instead of a red screen you get a blank region, a zero-size widget, or a silent paint skip. That is why you fix the cause in debug rather than shipping past a console warning: the symptom changes shape in release but the bug is still there.

## Finding the real culprit fast

Because this error cascades, the fastest path is to read the console top-down and stop at the first exception. Then narrow the subtree:

1. The first error names a widget and a source location (`lib/widgets/feed.dart:58`). Open that file and look at what the named widget's parent is. A scrollable whose parent is a `Column`, `Row`, `IntrinsicHeight`, or another scrollable is your suspect.
2. Turn on `debugPaintSizeEnabled = true;` in `main` (or toggle Debug Paint in the Flutter Inspector) to see every box's outline. A box that paints nothing or collapses to a line is the one that failed to lay out.
3. Open the Layout Explorer in DevTools and select the failing widget. Its constraints panel shows whether it received `h=unbounded` or `w=unbounded`, which confirms the diagnosis. If you have not used DevTools for layout work, the walkthrough in [profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) covers opening a session against a real device; the same session drives the Layout Explorer.

The deeper lesson is that `RenderBox was not laid out` is never the bug itself. It is Flutter reporting that it could not finish the job an earlier widget started. Train yourself to ignore the loudest message and find the quiet first one, and this error stops being mysterious. Keep your scrollables bounded, lay out children before measuring them, and never read a size before the frame that produces it, and the assertion never fires.

## Related

- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) is the sibling layout error: the flex laid out but its children did not fit, which is a different failure mode from a sizeless box.
- [Fix: setState() or markNeedsBuild() called during build in Flutter](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) is the other "I touched the framework at the wrong moment" error, and it shares the post-frame-callback fix.
- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) sets up the same DevTools session whose Layout Explorer pinpoints the unbounded constraint behind this error.
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) covers the `mounted` and lifecycle discipline that keeps post-frame size reads safe.

## Sources

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), the canonical explanation of how constraints, sizes, and the layout protocol fit together.
- [RenderBox.size API reference](https://api.flutter.dev/flutter/rendering/RenderBox/size.html), which states that a box's size is only valid during and after `performLayout` and requires `parentUsesSize: true` for parent reads.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), the official list that defines the unbounded-viewport and overflow errors that cause most of these cascades.
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967), a representative report of the `hasSize` assertion firing from a shrink-wrapping viewport given unbounded constraints.
