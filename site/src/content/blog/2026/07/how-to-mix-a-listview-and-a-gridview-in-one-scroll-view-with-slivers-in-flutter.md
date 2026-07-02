---
title: "How to mix a ListView and a GridView in one scroll view with slivers in Flutter"
description: "Put a list and a grid in a single continuous scroll without nested scrollables. Use CustomScrollView with SliverList and SliverGrid, and skip the shrinkWrap trap that quietly kills performance."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
---

You want a screen where a list flows straight into a grid (or the other way round) and the whole thing scrolls as one. The wrong instinct is to stack a `ListView` and a `GridView` in a `Column` and reach for `shrinkWrap: true` to make them fit. That compiles, but it builds every item up front and gives you two scroll positions fighting each other. The right answer is a single `CustomScrollView` whose sections are slivers: `SliverList` for the list part, `SliverGrid` for the grid part, `SliverToBoxAdapter` for any plain widget in between. One viewport, one scroll physics, full laziness. This post shows the working layout on Flutter 3.x (tested on 3.44, Dart 3.x), explains why the naive version is slow, and covers the spacing, padding, and cross-axis-count details that trip people up.

## Why you cannot just stack two scrollables

A `ListView` and a `GridView` are both scrollable viewports. Each one owns its own scroll position and expects to be handed a bounded height so it knows how tall its window is. Put two of them in a `Column` and you hit the same wall described in [how to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/): the `Column` offers each child unbounded vertical space, and a scrollable refuses to lay out into infinity.

The usual patch is `shrinkWrap: true` on both, wrapped in a `SingleChildScrollView`:

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

This renders, and for a dozen items it is fine. But `shrinkWrap: true` forces each scrollable to build and measure every one of its children on the first frame so it can report a finite height. You have thrown away the lazy recycling that keeps Flutter lists smooth. On a feed of a few hundred photos that is hundreds of widgets built before the first paint, a spike you can watch in the timeline (see [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Worse, you now have three scroll views (the outer `SingleChildScrollView` plus two inner ones you had to disable with `NeverScrollableScrollPhysics`) all present just so one of them can actually scroll. It is the wrong shape for the problem.

## What a sliver is, in one paragraph

A sliver is a scrollable region that talks directly to a parent viewport about how much of itself is currently visible and how much to paint. Instead of "here is my total height, give me a window," a sliver says "you are scrolled to offset X with a viewport of height H, so I will lay out exactly the children that fall in that range." That protocol is what makes a `SliverList` lazy: it never needs to know its own total height, so there is no unbounded-height handshake to fail and no need to build offscreen children. A `CustomScrollView` is a viewport that hosts a list of these slivers and scrolls through all of them as one continuous surface. Because every section is a sliver, they share the single scroll position of their parent, which is exactly the behavior you wanted.

## The working layout: SliverList then SliverGrid

Here is the whole thing. A header, a list section, and a grid section, in one scroll:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

Scroll it and the list flows into the grid as a single surface. Both sections are lazy: only the tiles inside the viewport (plus a small cache) are built, no matter how many posts or photos you have. There is one scroll position, so a fling started in the list carries through into the grid without a seam.

Three sliver types are doing the work here, and they are the three you will use for almost everything:

1. **`SliverToBoxAdapter`** wraps any ordinary box widget (a heading, a banner, a divider) so it can sit in a sliver list. It builds its child eagerly, which is correct for a single small widget but wrong for a long list, so never put a `ListView` or a big `Column` inside one. Use it for one-off widgets between your lazy sections.
2. **`SliverList.builder`** is the lazy list. Same `itemCount` / `itemBuilder` API you know from `ListView.builder`, minus the viewport, because the enclosing `CustomScrollView` is the viewport now.
3. **`SliverGrid.builder`** is the lazy grid. It takes a `gridDelegate` that controls the columns, exactly like `GridView.builder`.

## Controlling the grid columns

The `gridDelegate` is where you decide how many columns the grid has and how the tiles are spaced. Two delegates cover nearly every case.

`SliverGridDelegateWithFixedCrossAxisCount` pins a fixed number of columns. Use it when the count is a design decision ("always 3 across"):

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent` instead caps each tile's width and lets Flutter compute the column count from the available width. This is the responsive choice: a phone gets 2 columns, a tablet gets 5, without a `LayoutBuilder`:

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

The single most common grid frustration is tiles that look stretched or squashed, and the cause is almost always `childAspectRatio`. It is width divided by height. The default is `1.0` (square). If your photo tiles are taller than they are wide, drop the ratio below 1 (for example `0.75` for a 3:4 portrait card); if they are wider, push it above 1. A `childAspectRatio` mismatch does not throw, it just silently distorts every tile, so it is worth setting deliberately rather than leaving to the default.

## Adding padding without breaking laziness

Wrapping a sliver in an ordinary `Padding` widget does not work, because `Padding` expects a box child, not a sliver. The sliver equivalent is `SliverPadding`:

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

Note the `sliver:` parameter, not `child:`. `SliverPadding` insets a sliver and stays lazy. Reach for it whenever a section needs breathing room from the screen edges; wrapping the whole `CustomScrollView` body in one big `Padding` would clip the grid's spacing math and is the wrong layer to add margins.

## A scrolling header that collapses

Since you already have a `CustomScrollView`, adding a `SliverAppBar` that expands and collapses as you scroll is nearly free. This is the classic reason people move to slivers in the first place:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

Set `pinned: true` to keep the bar stuck at the top, `floating: true` to have it slide back in on any upward scroll, and `expandedHeight` with a `flexibleSpace` to get the large-to-small collapse. None of this is possible with a plain `Column` of scrollables, which is the concrete payoff for switching to slivers.

## The gotchas that actually bite

**Do not nest a scrollable inside a sliver.** The whole point is one viewport. Putting a `ListView` inside a `SliverToBoxAdapter` reintroduces the unbounded-height error and a second scroll position. If you have a horizontally scrolling row inside a vertical `CustomScrollView`, that is fine (different axis, give it a fixed height via a `SliverToBoxAdapter` wrapping a `SizedBox`), but never nest a same-axis scrollable.

**Keys matter when items reorder.** If the list or grid items can be inserted, removed, or reordered, give each tile a `ValueKey` tied to its data so Flutter matches the right state to the right widget across rebuilds. Without keys, a removed row can leave its state attached to the wrong tile.

**Watch the empty-section case.** A `SliverList` or `SliverGrid` with `itemCount: 0` simply paints nothing, which is what you want, but if you also want a "no photos yet" placeholder, use `SliverToBoxAdapter` or `SliverFillRemaining` to show it, not an empty grid.

**`SliverFillRemaining` fills the leftover viewport.** If the list plus grid do not fill the screen and you want a footer or empty-state pinned to the bottom of the visible area, `SliverFillRemaining(hasScrollBody: false, child: ...)` takes exactly the remaining height. It is the sliver version of `Expanded` for the last section.

**Grouping slivers together.** If you build several list-and-grid pairs and want to treat each pair as a unit (for example to apply one background), `SliverMainAxisGroup` (Flutter 3.16+) stacks child slivers along the scroll axis so they behave as a single sliver. You rarely need it for a simple list-plus-grid, but it is the tool when a section has internal structure.

## When a plain GridView or ListView is still right

Slivers are the answer when you are combining sections in one scroll. They are overkill when you have a single list or a single grid and nothing else scrolling with it. A lone `GridView.builder` inside a `Scaffold` body is already lazy and already the viewport; wrapping it in a `CustomScrollView` with one `SliverGrid` adds ceremony for no benefit. Reach for slivers the moment you have two or more scrollable sections, a collapsing header, or a header that must scroll away with the content. For everything else, the plain widgets are fine, and if your only problem is a single list refusing to fit in a `Column`, the four fixes in [the unbounded-height post](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) are the shorter road.

One more habit worth keeping: if any section uses a `ScrollController` (for example to jump the combined view to a section), attach it to the `CustomScrollView`, not to the individual slivers (slivers do not take a controller), and [dispose it](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) in your `State.dispose` so you do not leak it. And if a tile inside the grid ever overflows its cell, that surfaces as a [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) warning inside the tile, unrelated to the sliver wiring, fixed at the tile level.

## The mental model to keep

A `CustomScrollView` is one viewport; every section you put in it is a sliver, and slivers share that single scroll position while each stays lazy. `SliverList` and `SliverGrid` are the lazy list and grid, `SliverToBoxAdapter` is the escape hatch for one-off box widgets, `SliverPadding` adds margins, and `SliverAppBar` is the collapsing header you get almost for free. Once you stop thinking "stack two scrollables" and start thinking "one scroll made of slivers," mixing a list and a grid stops being a fight with the layout engine and becomes four lines of composition.

## Sources

- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- hosting multiple slivers in one viewport, including the SliverAppBar + SliverList + SliverGrid example.
- [SliverGrid class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- the builder/count/extent constructors and the two grid delegates.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- lazy list behavior and the SliverFixedExtentList note.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- the sliver protocol and how viewports negotiate paint extent.
