---
title: "How to add a Hero animation between two screens in Flutter"
description: "Wrap the same widget on both routes in a Hero with an identical tag and Flutter animates its position and size across the navigation. Full guide: images, flightShuttleBuilder, createRectTween, RectTween arcs, gesture transitions, and the tag collisions that break it. Tested on Flutter 3.44, Dart 3.12."
pubDate: 2026-07-14
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
---

Short answer: wrap the widget you want to animate in a `Hero` on the first screen, wrap the destination widget in a second `Hero` with the **same `tag`**, and push the destination route with the normal `Navigator`. Flutter's `HeroController` (installed by default in `MaterialApp` and `CupertinoApp`) finds the two heroes with the matching tag during the route transition, lifts the source hero into an overlay, and interpolates its position and size until it lands on the destination. You write no `AnimationController`, no `Tween`, and no explicit duration for the basic case. Verified on Flutter 3.44, Dart 3.12.

That is the whole trick, and it is genuinely two `Hero` widgets and one `Navigator.push`. The rest of this guide is the part that trips people up: the tag rules, animating an image or `Icon` that changes shape between screens, customizing the flight widget so it does not flicker across themes, curving the flight path, and the handful of errors that turn a smooth transition into a jarring jump.

## The minimal working example

Two screens. A colored box on the first, the same box larger on the second. The box flies between them.

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: FirstScreen());
  }
}

class FirstScreen extends StatelessWidget {
  const FirstScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('First')),
      body: Center(
        child: GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const SecondScreen()),
          ),
          child: Hero(
            tag: 'box-hero',
            child: Container(width: 80, height: 80, color: Colors.indigo),
          ),
        ),
      ),
    );
  }
}

class SecondScreen extends StatelessWidget {
  const SecondScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Center(
        child: Hero(
          tag: 'box-hero',
          child: Container(width: 240, height: 240, color: Colors.indigo),
        ),
      ),
    );
  }
}
```

Tap the small box and it grows and slides into the center of the second screen. Tap back and it reverses. The `tag` string `'box-hero'` is the entire binding between the two widgets. If the tags differ by a single character, nothing animates and both boxes just appear and disappear normally.

## Why matching tags are the whole mechanism

`Hero` does not hold a reference to its counterpart. Instead, at the moment a route transition starts, the `HeroController` walks the widget tree of both the outgoing and incoming routes and builds a map of tag to hero. For every tag present on **both** routes, it starts a "flight": the source hero is removed from its normal position (a `placeholderBuilder` fills the gap, empty by default), a copy is placed in the `Navigator`'s overlay `Stack`, and that copy is animated from the source `Rect` to the destination `Rect` using the route's own transition animation as the clock.

Two consequences fall out of this design, and both are the source of most Hero bugs:

1. **A tag must be unique within a single route.** If one screen has two `Hero` widgets with `tag: 'box-hero'`, Flutter cannot decide which one to fly and throws `There are multiple heroes that share the same tag within a subtree`. This bites hardest when you put a `Hero` inside a `ListView` item and give every item the same literal tag. Use the item's id: `tag: 'photo-${photo.id}'`.
2. **The hero must exist on the first frame of the destination route.** The controller inspects the destination route as it is being built. If your destination hero is behind a `FutureBuilder` that has not resolved, or inside an `Offstage`, or gated by an `if` that is false on the first build, there is no destination `Rect` to fly to and the animation is silently skipped.

## Animating an image or icon that changes shape

The most common real use is a thumbnail that expands into a full-bleed header. The child does not have to be identical on both routes, only tagged identically. Here the source is an 80x80 rounded thumbnail and the destination is a full-width image.

```dart
// Flutter 3.44, Dart 3.12
// Source: a grid thumbnail
Hero(
  tag: 'photo-${photo.id}',
  child: ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(photo.url, width: 80, height: 80, fit: BoxFit.cover),
  ),
);

// Destination: a full-width header
Hero(
  tag: 'photo-${photo.id}',
  child: Image.network(
    photo.url,
    width: double.infinity,
    height: 300,
    fit: BoxFit.cover,
  ),
);
```

Two things to watch when the child is an `Image`. First, use the same image `url` (ideally the same in-memory `ImageProvider`) on both routes so the network fetch is already cached and the flight does not show a half-loaded frame. Second, mismatched `BoxFit` or a `ClipRRect` on only one side produces a visible pop as the corner radius or crop snaps at the end of the flight. If the rounded corners matter, wrap both sides in the same `ClipRRect`, or use a `flightShuttleBuilder` (below) to interpolate the radius.

For an `Icon` or a piece of styled `Text`, the same rule applies: the framework tweens the bounding `Rect`, and it scales the source child's rendering to fit that rect during the flight. A 24px icon flying to a 96px icon looks correct because the child is scaled, not re-laid-out mid-flight.

## Customizing the flight widget with flightShuttleBuilder

By default the flight shows the destination hero's child, scaled. That default breaks in two situations: when the child reads an `InheritedWidget` (a `Theme`, `DefaultTextStyle`, or `MediaQuery`) that differs between the two routes, and when you want the widget to visibly morph, not just scale, during the flight. `flightShuttleBuilder` gives you full control over what is rendered while the hero is in the air.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'photo-${photo.id}',
  flightShuttleBuilder: (
    flightContext,
    animation,
    flightDirection,
    fromHeroContext,
    toHeroContext,
  ) {
    // Render the destination hero's widget, but wrapped in the
    // destination route's Material so text/icon theming is stable.
    return DefaultTextStyle(
      style: DefaultTextStyle.of(toHeroContext).style,
      child: toHeroContext.widget as Hero,
    );
  },
  child: Text(photo.title, style: Theme.of(context).textTheme.titleLarge),
);
```

The `flightDirection` argument is `HeroFlightDirection.push` or `HeroFlightDirection.pop`, so you can render a different shuttle on the way in versus the way out. The `animation` is the flight's `Animation<double>` from 0 to 1; use it to cross-fade or interpolate a `BorderRadius` if you want the corners to smoothly round off rather than snap. This is the correct fix for the "rounded corners pop at the end" problem: drive the radius from `animation.value` inside the shuttle.

## Curving the flight path with createRectTween

By default the hero moves in a straight line between the two rects, and its size interpolates linearly. Material's own detail transitions often use an **arc**: the widget follows a curved path, which reads as more natural for a card expanding into a page. Flutter ships `MaterialRectArcTween` for exactly this, and you opt in per hero with `createRectTween`.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  createRectTween: (begin, end) {
    return MaterialRectArcTween(begin: begin, end: end);
  },
  child: const SizedBox(width: 80, height: 80),
);
```

`createRectTween` runs on the hero that is the destination of the flight. If you want the arc on both push and pop, set it on both routes' heroes. The default is a plain `RectTween` (linear). `MaterialRectArcTween` curves the top-left and bottom-right corners along arcs, which is why an expanding card appears to "sweep" into place rather than shoot diagonally. As of Flutter 3.44 you can also pass a curve directly to the transition via the route, but `createRectTween` remains the way to shape the geometric path rather than the timing.

## Making the iOS back-swipe animate the hero

On a `CupertinoPageRoute` (or a `MaterialPageRoute` on iOS), the user can drag from the left edge to pop the route. By default the hero does **not** fly during that interactive drag; it only flies on a committed pop. Set `transitionOnUserGestures: true` on both heroes to make the shared element track the drag.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

Set it on both the source and destination hero. If you set it on only one, the push animates but the interactive pop does not, which feels inconsistent. This is cheap to add and there is rarely a reason to leave it off for a genuine shared-element pair.

## Hero animation with go_router and other routers

Nothing about `Hero` is tied to imperative `Navigator.push`. The animation is driven by the route transition, so it works the same under `go_router`, `auto_route`, or any router that builds on `Navigator` 2.0, as long as the destination page uses a transition-capable page (`MaterialPage`, `CupertinoPage`, or a `CustomTransitionPage`). Give the two widgets the same tag and navigate however your app normally does:

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

One caveat with declarative routers: if you use a `CustomTransitionPage` with a zero-duration or `NoTransitionPage`, there is no transition animation for the `HeroController` to drive, so the hero will not fly. Keep a real transition (even a short fade) on any route where you want a shared-element animation. For a deeper comparison of the routers themselves, see the notes on [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) and the [go_router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) breakdown.

## The errors that break Hero animations

These are the failures that turn up in bug reports, ranked by how often they land in search traffic.

1. **`There are multiple heroes that share the same tag within a subtree`.** Two heroes on the same route share a tag. Almost always a list where every item used a constant tag. Fix: derive the tag from a unique key such as `'item-${item.id}'`. If you legitimately need the same visual on screen twice, only one of them can participate in the flight; give the others distinct tags or no `Hero` at all.
2. **The hero just appears, no flight.** The destination hero is not present on the first frame. It is behind an unresolved `FutureBuilder`, inside an `Offstage`, or gated by a flag that is false on first build. Make sure the tagged widget is in the tree immediately, even if its data loads later, so there is a rect to fly to. A related trap is initializing that `Future` inside `build`, which recreates it every rebuild; see [initializing a Future so FutureBuilder does not recreate it](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).
3. **The child pops or flickers at the end of the flight.** Mismatched `BoxFit`, `ClipRRect` radius, or an `InheritedWidget`-dependent style between the two routes. Fix with a `flightShuttleBuilder` that renders a stable widget and interpolates the differing property from `animation.value`.
4. **`Navigator.pop` throws or the back arrow does nothing.** This is not a Hero problem, but it looks like one because it happens on the screen with the hero. Confirm the route was pushed with a `Navigator` that owns a `HeroController`. Custom nested `Navigator`s need their own `HeroController` in `observers` or heroes will not fly across them.
5. **Layout jumps because the hero has unbounded size.** A `Hero` wrapping a `Text` or `Row` inside a `Column` can hit an unbounded-width situation during the flight when it is lifted into the overlay `Stack`. Wrap the hero child in a `Material` with `type: MaterialType.transparency`, or give it explicit constraints. If you are hitting unbounded-height errors more generally, the pattern is the same family of layout bug covered in [nesting a ListView inside a Column](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).

## Text needs a Material ancestor during flight

A subtle one worth its own note: while a hero is in flight it lives in the `Navigator`'s overlay, detached from the `Scaffold` and its `Material`. `Text` and `Ink`-based widgets look up a `Material` ancestor for their default text style and ink splashes. During flight they may not find one, so styled text can render with the default black underline debug style for a frame. Wrap the flight child in a `Material`:

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'title-hero',
  flightShuttleBuilder: (ctx, anim, dir, fromCtx, toCtx) {
    return Material(
      type: MaterialType.transparency,
      child: toCtx.widget,
    );
  },
  child: Material(
    type: MaterialType.transparency,
    child: Text('Details', style: Theme.of(context).textTheme.headlineSmall),
  ),
);
```

`MaterialType.transparency` gives the text a `Material` ancestor to resolve its style without painting a background, which keeps the flight visually clean.

## When not to use a Hero

A `Hero` is the right tool when the *same conceptual element* exists on both screens: a thumbnail that becomes a header, an avatar that becomes a profile photo, a card that becomes a detail page. It is the wrong tool for decorative motion where nothing is shared. If you want the whole page to slide, fade, or scale, that is a route `transitionsBuilder` (or a `PageRouteBuilder`), not a `Hero`. If you want a widget to animate *within* one screen, reach for `AnimatedContainer`, `AnimatedPositioned`, or an explicit `AnimationController`. Hero specifically owns the cross-route shared-element case, and using it for anything else fights the framework.

For broader Flutter performance and UI work that often shows up alongside adding transitions, the guides on [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) and [setting an accent color with Material 3 ColorScheme](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) cover the two things people usually polish right after the navigation feels good: frame budget and theming.

## Sources

- Flutter API: [`Hero` class](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Flutter docs: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Flutter cookbook: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- Flutter API: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- Flutter API: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
