---
title: "shrinkWrap vs Expanded vs slivers for long lists in Flutter: which should you pick?"
description: "For a long list, never use shrinkWrap. Use Expanded when the list is the only scrollable, and slivers (CustomScrollView) when it shares a scroll with other sections. Here is why, with a build-count benchmark."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "slivers"
---

For a long list in Flutter, the ranking is not close: use `Expanded` when the list is the only scrollable under a header, and switch to slivers (a `CustomScrollView`) the moment the list shares a scroll with other sections. Never reach for `shrinkWrap: true` on a long list. It is the shortest diff and it silences the layout error, but it also forces the list to build every item on the first frame, throwing away the lazy recycling that keeps a scroll at 60fps. This post pits the three against each other on Flutter 3.x (tested on 3.44, Dart 3.x), with a feature matrix, a build-count benchmark that shows the exact cost, and the one gotcha that decides it for you.

The three are not interchangeable knobs on the same widget. `Expanded` and `shrinkWrap` are two ways to answer "how tall is this `ListView` inside a `Column`," while slivers replace the `Column`-plus-`ListView` shape entirely. They collide because they are the three answers people try when a `ListView` in a `Column` throws `Vertical viewport was given unbounded height`. If that assertion is what brought you here, the full root-cause walk-through is in [how to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/); this post is the sharper question of which fix to keep once the red screen is gone.

## The feature matrix

| Property                              | `shrinkWrap: true` | `Expanded`         | Slivers (`CustomScrollView`) |
| ------------------------------------- | ------------------ | ------------------ | ---------------------------- |
| Builds only visible items (lazy)      | No, builds all     | Yes                | Yes                          |
| First-frame cost for N items          | O(N)               | O(viewport)        | O(viewport)                  |
| Memory scales with                    | item count         | viewport size      | viewport size                |
| Works for an unbounded / growing list | No                 | Yes                | Yes                          |
| Needs a bounded parent height         | No                 | Yes (parent must)  | Yes (Scaffold gives it)      |
| Multiple scrollable sections in one   | Fights itself      | One list only      | Yes, native                  |
| Collapsing header (`SliverAppBar`)    | No                 | No                 | Yes                          |
| Lines of boilerplate                  | 1                  | 3                  | ~6 per section               |

Read the top three rows first. They are the whole argument. `shrinkWrap` is the only one of the three whose cost grows with the number of items, and "long list" is exactly the case where that cost bites.

## Why shrinkWrap is O(N) and the other two are not

A normal `ListView` is a lazy viewport: it builds and lays out only the items visible in its window plus a small cache extent, then recycles those widgets as you scroll. Build a 10,000-row list and only ~15 rows exist at any moment. That laziness is the entire performance story of Flutter lists.

`shrinkWrap: true` turns it off. To size itself to its content (instead of filling its axis), the viewport must know its total height, and the only way to know that is to build and measure every child up front. So `shrinkWrap` converts a lazy list into an eager one: N items means N build calls on the first frame, N `RenderBox` layouts, and memory proportional to N. For the three settings rows people usually test it on, that is nothing. For a feed, it is a first-frame stall you can watch in the timeline (see [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)).

`Expanded` keeps the list lazy. It is a `Flex` child that forces a tight height equal to the space left over after the `Column` measures its other children. The `ListView` receives a bounded `maxHeight`, fills exactly that window, and recycles rows inside it. Cost is O(viewport), independent of item count.

Slivers keep the list lazy too, by a different mechanism: a `SliverList` never needs to know its own total height. It negotiates directly with the parent viewport ("you are scrolled to offset X, I will paint the children in that range"), so there is no unbounded-height handshake and no reason to build offscreen children. Cost is again O(viewport).

## The build-count benchmark

The cleanest way to measure this is not milliseconds (which vary by machine) but the number of item builds on the first frame, which is deterministic and mechanism-driven. Instrument each item with a counter:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
int buildCount = 0;

Widget itemBuilder(BuildContext context, int index) {
  buildCount++;                 // increment on every item build
  return ListTile(title: Text('Row $index'));
}
```

Render a list of 5,000 items three ways and read `buildCount` after the first frame (`WidgetsBinding.instance.addPostFrameCallback`). The results are not close:

| Layout for 5,000 items      | Item builds on first frame | Scales with   |
| --------------------------- | -------------------------- | ------------- |
| `ListView(shrinkWrap: true)`| 5,000                      | item count    |
| `Expanded(child: ListView)` | ~12 to 15                  | viewport only |
| `SliverList` in `CustomScrollView` | ~12 to 15           | viewport only |

The exact lazy number depends on row height and the default `cacheExtent` (250 logical pixels beyond the viewport on each side), but the shape is fixed: `shrinkWrap` builds all 5,000, the other two build only what fits plus the cache. On a Pixel 7 in profile mode the `shrinkWrap` first frame ran well past the 16ms budget building those 5,000 tiles, while the `Expanded` and sliver versions rendered the first frame inside budget and stayed there while scrolling. The number that matters is the ratio: ~5,000 builds versus ~15, a difference that grows every time the list does.

To reproduce this yourself, run in profile mode (`flutter run --profile`), not debug, because debug-mode timings are dominated by assertions and are not representative. The build-count ratio is identical in every mode; only the wall-clock differs.

## When to pick Expanded

`Expanded` is the right answer when the list is the single scrollable region of the screen, sitting under (or over) some fixed chrome.

- **A header over a feed, tested on Flutter 3.44.** A title or search bar in a `Column`, then the list fills the rest. `Expanded` gives the list all leftover height and keeps it lazy.
- **A list that grows and shrinks with the screen.** Because `Expanded` divides the available space rather than hardcoding it, the list adapts to different device heights and text-scale settings, unlike a `SizedBox(height: ...)`.
- **You want the least code that stays correct.** Three lines, no new widget vocabulary, full laziness. For a single list this beats reaching for slivers.

The one requirement: the `Column` itself must have a bounded height for `Expanded` to have something to divide. Inside a `Scaffold` body it does. If the `Column` is itself in an unbounded context, you have only moved the problem up a level.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const SearchBar(),
    Expanded(
      child: ListView.builder(       // stays lazy
        itemCount: items.length,
        itemBuilder: (context, i) => ItemTile(items[i]),
      ),
    ),
  ],
)
```

## When to pick slivers

Reach for a `CustomScrollView` with slivers when the long list is not alone: it shares one scroll with other sections, or the screen needs a header that scrolls away.

- **Two or more scrollable sections in one scroll**, for example a list flowing into a grid. This is the case covered end to end in [how to mix a ListView and a GridView in one scroll view with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/). Stacking two `ListView`s in a `Column` and disabling their physics is the anti-pattern slivers exist to replace.
- **A collapsing or floating header.** `SliverAppBar` with `pinned`, `floating`, or `expandedHeight` is nearly free once you already have a `CustomScrollView`. There is no `Column`-based equivalent.
- **A header that should scroll off with the content.** `SliverToBoxAdapter` wraps a one-off box widget between lazy sections so it scrolls away naturally.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(title: Text('Explore'), floating: true),
    SliverList.builder(              // lazy, shares the one scroll position
      itemCount: items.length,
      itemBuilder: (context, i) => ItemTile(items[i]),
    ),
  ],
)
```

Slivers are more verbose, roughly six lines per section instead of three, and that verbosity is the only reason not to use them for a lone list. When there is exactly one scrollable, `Expanded` gives the same laziness with less ceremony.

## When shrinkWrap is actually fine

`shrinkWrap: true` is not a bug, it is a tool with a narrow correct use: a **short, bounded** list whose item count you control and that must size itself to its content so widgets can sit above and below it in the same `Column`.

- A settings screen with a fixed handful of rows.
- A dropdown or menu with a known small set of options.
- Any list where N is small (single digits, low tens) and fixed by design, not by data.

The moment N is driven by data that can grow (posts, photos, search results, messages), `shrinkWrap` is the wrong tool, because its cost grows with that data. If you use it for a short list inside a scrolling `Column`, also set `physics: const NeverScrollableScrollPhysics()` so the inner list does not fight the outer `SingleChildScrollView` for the scroll gesture.

```dart
// Flutter 3.x (tested 3.44) -- fine ONLY because this list is short and fixed
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        SwitchListTile(title: Text('Notifications'), value: true, onChanged: null),
        SwitchListTile(title: Text('Dark mode'), value: false, onChanged: null),
      ],
    ),
  ],
)
```

## The gotcha that picks for you

Two constraints override preference entirely.

**If the list can grow without bound, `shrinkWrap` is off the table.** It is not a matter of taste or a few dropped frames you might tolerate. An unbounded eager build is a correctness and memory problem: build time and memory both scale with item count, so a list that is fine in testing with 20 rows can lock the first frame for hundreds of milliseconds in production with 2,000. The framework will not warn you, because `shrinkWrap` did exactly what you asked. This is the single most common way a Flutter list quietly regresses.

**If you have more than one scrollable section, slivers are the only clean answer.** `Expanded` handles exactly one list. Two `Expanded` lists in a `Column` split the height between them into two separate scroll views, which is almost never what you want. The instant you have a list plus a grid, or a list plus another list, or any section that must scroll as one surface with the list, a `CustomScrollView` is the structurally correct shape and everything else is a workaround.

Everything else, screen adaptivity, boilerplate, a collapsing header, is a tiebreaker within those two hard rules.

## The recommendation, restated

For a long list, rank them: **slivers if the list shares a scroll with anything else, `Expanded` if it is the only scrollable, and `shrinkWrap` never.** Keep `shrinkWrap: true` in your toolbox only for short, fixed lists that must size to their content inside a `Column`. The trap is that all three make the unbounded-height error disappear, so it is easy to ship the one that also silently trades a loud layout assertion for a performance regression that only shows up under real data. Read the choice as "how do I keep the list lazy," and the answer is always `Expanded` or slivers, never `shrinkWrap`.

If a row inside any of these ever overflows its own width, that is a separate [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) problem at the tile level, unrelated to the outer layout choice. And whichever layout you pick, if it uses a `ScrollController`, remember to [dispose it](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) so you do not leak it when the widget unmounts.

## Sources

- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, viewport behavior, and the explicit note that a shrink-wrapped list builds all children.
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- flex fit and how a `Column` divides remaining space.
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- hosting multiple slivers in one lazy viewport.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- the sliver protocol and how a viewport negotiates paint extent.
- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- the bounded vs unbounded height model behind the whole comparison.
