---
title: "Fix: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter CustomScrollView)"
description: "The slivers list of a CustomScrollView only accepts slivers. Wrap box widgets in SliverToBoxAdapter, or swap ListView/Padding/Column for SliverList and SliverPadding."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph` (or `RenderFlex`, or `RenderErrorBox`, or any other `RenderBox`) means you put a plain widget directly inside a `CustomScrollView`'s `slivers` list. Everything in `slivers` must be a sliver. The quickest fix is to wrap the offending box widget in a `SliverToBoxAdapter`; the better fix, for a list, is to replace `ListView` with `SliverList.builder` and `Padding` with `SliverPadding`. Tested on Flutter 3.x (3.44), Dart 3.x.

## The error in context

Flutter throws this at layout time, before it paints anything. The concrete type after "received a child of type" changes depending on what you put in the list -- `RenderParagraph` for a `Text`, `RenderFlex` for a `Column` or `Row`, `RenderErrorBox` when a builder inside the list threw -- but the shape is always the same:

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

The two "created by" blocks are the useful part. The first names the scroll widget that expected a sliver (almost always your `CustomScrollView`). The second names the exact widget that was not a sliver. Read the second block first: it points straight at the line you need to change.

## Why a viewport refuses a box child

Flutter has two layout protocols, not one. Ordinary widgets like `Container`, `Text`, `Row`, and `Column` are laid out as boxes: the parent passes down width and height constraints, the child returns a concrete `Size`, done. Their render objects are `RenderBox` subclasses (`RenderParagraph`, `RenderFlex`, and so on).

Slivers use a different, richer protocol built for scrolling. A sliver does not just report a size. During layout it receives a `SliverConstraints` describing how much of it is currently scrolled off-screen, how much room is left in the viewport, the scroll offset, the axis direction, and more. It returns a `SliverGeometry` describing how much space it painted, how much it consumed on the scroll axis, its hit-test extent, and whether it wants to be visible. That back-and-forth is what lets a `SliverAppBar` shrink as you scroll and a `SliverList` build only the rows currently on screen. Its render objects are `RenderSliver` subclasses.

A `RenderViewport` -- the render object behind `CustomScrollView` -- speaks only the sliver protocol to its children. It hands each child `SliverConstraints` and expects `SliverGeometry` back. If you give it a `RenderBox`, that box has no idea what to do with `SliverConstraints`; it does not implement the method the viewport is about to call. Rather than crash deep inside layout with a confusing null, the framework checks the child's type up front and throws this assertion. The message spells out the rule: "a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol," and the same is true in reverse, which is exactly the mismatch you hit.

So this is not a subtle constraint bug like [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) or a [RenderFlex overflow](/2026/05/fix-renderflex-overflowed-in-flutter/). It is a type mismatch: a box widget standing where a sliver belongs.

## The minimal repro

Any non-sliver widget in the `slivers` list triggers it. Here is the smallest version -- a bare `Text` where a sliver should be:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

The `SliverList.builder` is fine. The `Text` is the problem: it becomes a `RenderParagraph`, the viewport expected a `RenderSliver`, and layout throws. The same thing happens if you drop a `Column`, a `Padding`, a `Center`, a `ListView`, or an entire custom page widget into `slivers`. If it is not a sliver, the viewport rejects it.

## Fix 1: wrap a single box widget in SliverToBoxAdapter

For a one-off box widget -- a heading, a banner, a card, a button row -- wrap it in `SliverToBoxAdapter`. That widget is a sliver whose entire job is to host one `RenderBox` child and translate between the two protocols: it measures the box, then reports the appropriate `SliverGeometry` to the viewport.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

This is the direct fix and the right one when the box content is genuinely a single, fixed-size chunk. It is the sliver you reach for first when a header, a spacer, or a summary card needs to sit above your lists in one scroll view.

The one thing to know: `SliverToBoxAdapter` builds its child eagerly and keeps it alive whether or not it is on screen, because a box has no notion of laziness. That is fine for a header. It is wrong for a long list, which is Fix 2.

## Fix 2: use SliverList / SliverGrid for lists, not a wrapped ListView

The most common mistake is dropping a `ListView` into `slivers` and then, when this error appears, wrapping the `ListView` in `SliverToBoxAdapter`. That silences the assertion but it is the wrong shape. You now have a scrollable inside a scrollable, and the inner `ListView` receives unbounded height from the adapter -- the same failure family as [nesting a ListView in a Column](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). Even if you force it to work with `shrinkWrap`, you throw away lazy building: every row is constructed up front.

The whole point of a `CustomScrollView` is that its sections are slivers sharing one viewport. So use the sliver list, not a boxed `ListView`:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`, `SliverList.separated`, `SliverFixedExtentList`, and `SliverGrid.builder` are the sliver equivalents of the `ListView`/`GridView` builders. They keep the lazy building that makes long lists cheap, and they slot straight into `slivers`. If you want a list and a grid flowing in one continuous scroll, this is the layout for it -- see [mixing a ListView and a GridView with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) for the full pattern.

## Fix 3: SliverPadding instead of Padding, SliverFillRemaining instead of a box

The box-versus-sliver rule catches the wrapper widgets too. If you wrap a sliver in `Padding` to inset it, `Padding` is a `RenderBox` and the viewport rejects it. The sliver-aware version is `SliverPadding`, which pads a sliver child and stays a sliver:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

Watch the parameter name: `SliverPadding` takes `sliver:`, not `child:`, because its child must itself be a sliver. The same idea covers a few other common needs:

- **A box that should fill the leftover viewport** (an empty-state message centered in whatever space is left): `SliverFillRemaining(child: ...)`.
- **A box that should be exactly one screen tall**: `SliverFillViewport`.
- **A pinned or floating header that shrinks on scroll**: `SliverAppBar`, which is already a sliver, so it goes in `slivers` directly.
- **Grouping several slivers to apply one clip or decoration**: `SliverMainAxisGroup` / `SliverCrossAxisGroup`.

The mental model: for every box widget you would normally use, either wrap it (`SliverToBoxAdapter`, `SliverFillRemaining`) or find its sliver twin (`SliverList`, `SliverGrid`, `SliverPadding`, `SliverAppBar`).

## Gotchas and lookalikes

**A builder inside slivers that throws shows this same error.** When the received type is `RenderErrorBox`, the child was an `ErrorWidget`: something inside a `StreamBuilder` or `FutureBuilder` sitting in your `slivers` threw during build, Flutter substituted its red error box (a `RenderBox`), and the viewport rejected that. The fix is two-part: make the builder return a sliver on every path, and handle the error case. A `StreamBuilder` in `slivers` must return a sliver from its `builder`, including the error and loading branches:

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

If you return a bare `Text` or `CircularProgressIndicator` from any branch, you are back to the original error. (While you are here, if a `FutureBuilder` re-runs its future on every rebuild, that is a separate bug worth fixing -- see [how to stop FutureBuilder from recreating its Future](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)

**The reverse mismatch reads almost the same.** If you put a sliver where a box belongs -- say a `SliverList` inside a `Column` -- you get "A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" or "expected a RenderBox but received a RenderSliverPadding." Same rule, opposite direction: slivers only live inside a viewport (`CustomScrollView`, or the slivers area of `NestedScrollView`), never directly inside a `Column`, `Center`, or `Padding`. To turn a sliver back into something a box parent accepts, you generally do not: you restructure so the sliver is inside a `CustomScrollView`.

**`SliverToBoxAdapter` is not a place to hide a long list.** It works, so it is tempting, but it defeats laziness: the adapter builds its entire child subtree immediately. Wrapping a 5,000-row `ListView` (or a `Column` of 5,000 children) in one means building all 5,000 on the first frame, which spikes layout time and shows up as jank in the timeline. Use it for headers and single cards; use `SliverList.builder` for anything that scrolls.

**Hot reload sometimes cannot recover from this.** Because the assertion fires during layout, a hot reload after fixing the code can occasionally leave the render tree wedged. If the error persists after you have clearly fixed the offending line, do a hot restart (`R`), not a hot reload (`r`).

## Related

- [How to mix a ListView and a GridView in one scroll view with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- the correct multi-section `CustomScrollView` layout this error is pushing you toward.
- [How to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- the failure you hit if you "fix" this by boxing a ListView.
- [Fix: RenderBox was not laid out in Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- the other layout-time assertion you meet while wiring up scroll views.
- [Fix: A RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) -- constraint trouble in `Row`/`Column`, the box-side cousin of this problem.

## Sources

- [RenderViewport class, Flutter API reference](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html) -- the render object that speaks the sliver protocol and rejects box children.
- [SliverToBoxAdapter class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html) -- wrapping a single box widget as a sliver.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- the lazy list sliver and its `.builder` / `.separated` constructors.
- [flutter/flutter issue 126064](https://github.com/flutter/flutter/issues/126064) -- the `RenderErrorBox` variant, where a throwing builder inside `slivers` produces this same assertion.
