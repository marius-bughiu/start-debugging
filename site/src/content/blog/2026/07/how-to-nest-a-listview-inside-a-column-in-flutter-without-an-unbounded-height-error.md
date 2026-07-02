---
title: "How to nest a ListView inside a Column in Flutter without an unbounded-height error"
description: "Why a ListView in a Column throws 'Vertical viewport was given unbounded height', and the four fixes (Expanded, Flexible, shrinkWrap, SizedBox) with the performance trade-offs that decide which one you want."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "constraints"
---

Drop a `ListView` straight into a `Column` and Flutter throws before it ever paints a pixel: `Vertical viewport was given unbounded height`, usually followed by a wall of `RenderBox` diagnostics. The short answer: a `Column` hands its children unbounded vertical space, and a scrollable `ListView` refuses to render into infinite height because it would have no idea how tall to be. You fix it by giving the list a bounded height, and the right tool is almost always `Expanded` (fill the leftover space) when the list is the only scrollable, or `shrinkWrap: true` when the list is short and finite. This post explains why the error happens, shows the smallest repro, and walks through all four fixes on Flutter 3.x (tested on 3.44) so you pick the one that fits, not just the one that silences the exception.

## Why a Column gives its children unbounded height

Flutter layout runs on a single rule: constraints go down, sizes come up. A parent tells each child the minimum and maximum width and height it may occupy, the child picks a size inside those limits, and the parent positions it. The whole framework is that handshake repeated down the tree.

A `Column` is a `Flex` widget laid out along the vertical axis. Along its main axis (vertical) it does **not** impose a maximum height on its non-flexible children. It tells each child, in effect, "be as tall as you want, I will stack you and measure the total afterward." In constraint terms the child receives `maxHeight: double.infinity`. That is what "unbounded" means: the incoming height constraint has no finite maximum.

Most widgets are fine with that. A `Text`, a `Row`, an `Icon`, a `Container` with children all size themselves to their content, so an infinite ceiling never matters. They report back a concrete height and the `Column` adds it up.

A `ListView` is different. It is a scrollable viewport, and a viewport's whole job is to be a fixed window onto content that may be far larger than itself. To do that it needs to know how tall the window is. Along its scroll axis (vertical) a `ListView` tries to expand to fill all the height it is offered. Offer it infinity and it would try to become infinitely tall, which defeats the point of scrolling and cannot be laid out. So instead of silently producing a broken layout, the framework asserts:

```
The following assertion was thrown during performResize():
Vertical viewport was given unbounded height.
Viewports expand in the scrolling direction to fill their container. In this
case, a vertical viewport was given an unlimited amount of vertical space in
which to expand.
```

Put plainly: a `Column` says "take all the height you want," a `ListView` says "I only work if you tell me exactly how much height I get," and the two are incompatible until you insert a widget that resolves the height. This is the same family of failure as [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), where a missing size constraint stops layout before painting.

## The minimal repro

Here is the smallest widget that reproduces it. Nothing exotic, just a heading stacked above a list:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Recent activity'),
        ListView(
          children: const [
            ListTile(title: Text('Item 1')),
            ListTile(title: Text('Item 2')),
            ListTile(title: Text('Item 3')),
          ],
        ),
      ],
    );
  }
}
```

Run it and you get the unbounded-height assertion the moment this subtree lays out. The `Column` offered the `ListView` infinite height; the `ListView` gave up. Everything below is a way to change what height the `ListView` receives.

## Fix 1: Expanded, when the list should fill the leftover space

This is the fix you want most of the time. `Expanded` is a flex child that tells the `Column` to give it all the vertical space that remains after the non-flexible children are measured. Because "all the remaining space" is a concrete number once the `Column` knows its own height, the `ListView` now receives a bounded `maxHeight` and lays out normally, keeping full lazy scrolling.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

The mechanics: `Expanded` sets its child's flex factor and forces a tight height equal to its share of the free space. The `Column` measures `Text` first, subtracts that from its own height, and hands the rest to `Expanded`, which passes it down as a bounded constraint. The `ListView` fills exactly that window and scrolls its children inside it. This is the correct choice whenever the list is the main scrollable region of the screen and you want it to grow and shrink with the available height, which is the overwhelmingly common case (a header over a feed, a form field over results, a title over a chat log).

One requirement: the `Column` itself must have a bounded height for `Expanded` to have anything to divide up. Inside a `Scaffold` body, a `SizedBox` with a height, or any parent that already constrains vertical space, it does. If the `Column` is itself inside another unbounded context, you have pushed the same problem one level up and need to bound the outer box first.

If you want the list to take remaining space but also be allowed to shrink below its share when content is small, use `Flexible` instead of `Expanded`. `Expanded` is `Flexible` with `fit: FlexFit.tight`; plain `Flexible` uses `FlexFit.loose`, meaning "up to this much, but no more than your content needs." For a `ListView`, which wants to fill its axis, the two behave the same in practice, so reach for `Expanded` unless you have a mixed layout where looseness matters.

## Fix 2: shrinkWrap, when the list is short and finite

If the list has a small, known-ish number of items and you want it to be exactly as tall as its content (so the `Column` can stack more widgets below it), set `shrinkWrap: true`:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    ListView(
      shrinkWrap: true,
      children: const [
        ListTile(title: Text('Item 1')),
        ListTile(title: Text('Item 2')),
        ListTile(title: Text('Item 3')),
      ],
    ),
    const Text('End of list'),
  ],
)
```

`shrinkWrap: true` flips the viewport's behavior: instead of expanding to fill its axis, it measures all of its children, sums their heights, and sizes itself to that total. Now it reports a finite height up to the `Column`, the assertion is gone, and you can place widgets both above and below it.

The cost is real and worth understanding. A normal `ListView` is lazy: it only builds and lays out the items currently visible in the viewport plus a small cache. That is what keeps a 10,000-row list at 60fps. `shrinkWrap: true` throws that away, because to know its total height the viewport must build and measure **every** child up front. For a handful of items that is nothing. For a long or unbounded list it means building thousands of widgets on the first frame, which spikes layout time and causes the jank you can watch in the timeline (see [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). A `shrinkWrap` list also does not scroll independently in the usual sense; it grows to fit, and if the whole `Column` overflows you are back to a [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) warning. The rule of thumb: `shrinkWrap` is for short, bounded lists (a few settings rows, a fixed menu), not for feeds.

If you use `shrinkWrap` and still want the outer `Column` to scroll when everything together is too tall, wrap the `Column` in a `SingleChildScrollView` and set the inner `ListView` to `physics: const NeverScrollableScrollPhysics()` so the two scrollables do not fight:

```dart
// Flutter 3.x (tested 3.44)
SingleChildScrollView(
  child: Column(
    children: [
      const Text('Recent activity'),
      ListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
        ],
      ),
    ],
  ),
)
```

## Fix 3: SizedBox, when you know the exact height

If the list occupies a fixed slice of the screen, wrap it in a `SizedBox` with a concrete height. This is the most direct answer to the error: the `ListView` asked how tall it should be, and you told it.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    SizedBox(
      height: 240,
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

The `SizedBox` imposes `maxHeight: 240` on the `ListView`, which fills those 240 logical pixels and scrolls its content lazily inside them, keeping the performance win that `shrinkWrap` gives up. This is right for horizontal carousels (a fixed-height row of cards inside a vertical `Column`) and any design where the list's height is a deliberate constant. The downside is the magic number: hardcoded heights do not adapt to different screen sizes or text-scale settings, so avoid it for a list that is meant to fill whatever space is left. For that, `Expanded` is the adaptive version of the same idea.

## Fix 4: swap the Column for a CustomScrollView with slivers

When the "column" is really a scrolling page that happens to contain a list, the cleanest structure is not a `Column` with a nested `ListView` at all. It is a single `CustomScrollView` whose sections are slivers. One viewport, one scroll physics, full laziness, no nesting conflicts:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 3,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item ${index + 1}'),
      ),
    ),
  ],
)
```

A sliver is a scrollable region that negotiates directly with the parent viewport about how much it paints, so there is no "unbounded height" handshake to fail. `SliverToBoxAdapter` wraps ordinary box widgets (your header) and `SliverList.builder` is the lazy list. Reach for this when a screen has several stacked scrollable sections, a header that should scroll away, or a list plus a grid in one continuous scroll. It is more verbose than a `Column`, but it is the layout Flutter actually wants for this shape, and it never forces you to choose between correctness and laziness.

## Which fix do I actually use

- **List is the main content under a header, should fill the screen:** `Expanded`. Keeps laziness, adapts to any height.
- **A few fixed items, want widgets above and below in the same `Column`:** `shrinkWrap: true`. Cheap because the list is short.
- **List needs a specific fixed height (carousel, mini-list):** `SizedBox(height: ...)`. Keeps laziness, explicit and simple.
- **Whole screen is a scroll with several sections:** `CustomScrollView` with slivers. The structurally correct answer.

The trap to avoid is reaching for `shrinkWrap: true` reflexively because it is the shortest diff. It makes the red error disappear, but on a long list it quietly trades a loud layout assertion for a silent performance regression: every row built on frame one, dropped frames on load, and memory that scales with item count instead of viewport size. If the list can grow, use `Expanded` or slivers so the framework can keep recycling rows. Related debugging notes live in [Fix: RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) and [Fix: A RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/), which are the two errors you are most likely to hit next while wiring this up. And if the list uses a `ScrollController`, remember to [dispose it](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) so you do not leak it when the widget unmounts.

## The one-line mental model to keep

A `Column` gives unbounded height; a `ListView` demands bounded height. Every fix above is just a different way to answer "how tall?" -- `Expanded` says "the leftover," `SizedBox` says "exactly this," `shrinkWrap` says "as tall as my children," and slivers say "let the outer viewport decide." Once you read the error as "you forgot to tell the scrollable its height," the fix is obvious every time.

## Sources

- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- the "constraints go down, sizes go up" model and the box that decides bounded vs unbounded.
- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, viewport behavior, and the performance note about building all children.
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- flex fit and how remaining space is divided in a `Column` or `Row`.
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- combining slivers in a single viewport.
