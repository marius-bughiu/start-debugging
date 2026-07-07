---
title: "Flutter 3.44: Read the Physical Screen Corner Radius from MediaQuery"
description: "Flutter 3.44 exposes the device's rounded display corners through MediaQuery.displayCornerRadiiOf. Stop guessing a magic radius and clip your UI to the exact hardware curve on Android API 31+."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
---

Phones stopped having square screens years ago, but Flutter never told you how round the corners actually were. If you wanted a card or a full-bleed sheet to hug the physical curve of the display, you hardcoded a `BorderRadius.circular(24)` that you eyeballed against one device and hoped looked fine on the rest. Flutter 3.44, the current stable release, finally reads that value straight from the hardware and hands it to you through `MediaQuery`.

## The value the OS already knew

Android has exposed per-corner radii through its `RoundedCorner` API since API level 31, but the framework never surfaced them. [PR #179219](https://github.com/flutter/flutter/pull/179219) plumbs those radii from the engine's window metrics all the way up into `MediaQueryData`. You read them the same way you read padding or view insets:

```dart
final BorderRadius? corners = MediaQuery.displayCornerRadiiOf(context);
```

The return type is a nullable `BorderRadius`. Each corner is a `Radius` in logical pixels, so it composes directly with the widgets you already use. On Android below API 31, on iOS, and on every other platform, the value is `null`, so a null check is your fallback path, not an afterthought.

## Clipping to the hardware curve

The obvious use is a full-screen surface whose rounding matches the glass. Before, you invented a number. Now you ask the display:

```dart
@override
Widget build(BuildContext context) {
  final BorderRadius radius =
      MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.circular(16);

  return ClipRRect(
    borderRadius: radius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: content,
    ),
  );
}
```

Because `displayCornerRadii` is a real `BorderRadius`, its four corners can differ. That matters on devices where the bottom sweep is tighter than the top, or where a folding hinge gives one edge a different profile. You can also pull a single corner when you only need one:

```dart
final Radius topLeft =
    (MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.zero).topLeft;
```

## Physical pixels when you need them

`MediaQuery` gives you logical pixels, which is what layout code wants. If you are working at the raw pixel level, for example inside a custom `RenderObject` or a shader, the same data sits on the view: `FlutterView.displayCornerRadii` returns the values in physical pixels. Pick the one that matches the coordinate space you are drawing in and you avoid a `devicePixelRatio` multiply that is easy to get backwards.

## Where this actually pays off

Most apps do not need pixel-perfect corner matching, and `SafeArea` still handles the common case of keeping content out of the notch. This is for the surfaces that read as part of the device itself: bottom sheets that slide up to the glass edge, immersive media players, kiosk layouts, and the new predictive-back transitions, which Flutter 3.44 already wires up to `displayCornerRadii` so the outgoing screen shrinks into a correctly rounded rectangle.

The feature is small, but it closes a gap that forced every designer-developer handoff to end in a guessed number. Treat `null` as "assume square, fall back to your own constant" and the rest is just reading a value the OS was holding all along. See the [MediaQueryData.displayCornerRadii docs](https://api.flutter.dev/flutter/widgets/MediaQueryData/displayCornerRadii.html) for the full contract.
