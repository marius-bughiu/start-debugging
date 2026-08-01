---
title: "Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter"
description: "The keyboard shrinks your Scaffold body's max height, so a Column that just fit now overflows. Wrap the body in a scrollable instead of turning resizeToAvoidBottomInset off."
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
---

Wrap the `Scaffold` body in a `SingleChildScrollView` (or turn the `Column` into a `ListView`). The keyboard does not overlay your layout, it shrinks it: `Scaffold` subtracts `MediaQuery.viewInsets.bottom` from the max height it hands the body, so a `Column` that exactly filled the screen is now over budget by the height of the keyboard. Setting `resizeToAvoidBottomInset: false` also silences the stripe, but it does it by letting the keyboard cover your text field, which is almost never what you want. This post is written against Flutter 3.x (tested on 3.44) and Dart 3.x.

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

The tell that this is the keyboard variant and not the [generic RenderFlex overflow](/2026/05/fix-renderflex-overflowed-in-flutter/) is timing: the layout is clean until you tap a `TextField`, the overflow number is suspiciously close to the keyboard height (250 to 350 logical pixels on most phones), and it disappears the moment you dismiss the keyboard.

## Why the keyboard shrinks the body instead of covering it

On Android, the Flutter project template sets `android:windowSoftInputMode="adjustResize"` on `MainActivity`, so the platform resizes the Flutter view rather than panning it. The engine reports the covered region to Dart as `MediaQueryData.viewInsets`, which the API docs define precisely: when a mobile device's keyboard is visible, `viewInsets.bottom` corresponds to the top of the keyboard.

`Scaffold` then does the arithmetic. In `_ScaffoldState.build` it computes the minimum insets it has to keep clear:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

and in `_ScaffoldLayout.performLayout` it turns that into the body's height budget:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` is `widget.resizeToAvoidBottomInset ?? true`, so this is the default path. On an 852 pixel tall screen with a 56 pixel app bar and a 291 pixel keyboard, the body's `maxHeight` drops from 796 to 505. Your `Column` still wants 796. `RenderFlex` does not clip and does not scroll, so it paints the striped warning and reports the difference, which is exactly the 291 pixels in the message. The number is the keyboard height because the layout previously fit with zero slack.

## A repro that fits on one screen and then does not

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

This renders perfectly. Tap either field and the overflow appears. Nothing about the widget tree changed; only the incoming `maxHeight` did.

## The fixes, in the order you should try them

### 1. Make the body scrollable

This is the correct fix for roughly every form, and it is what the [Flutter common errors documentation](https://docs.flutter.dev/testing/common-errors) recommends for a bottom overflow. A viewport gives its child unbounded main-axis space, so the `Column` stops caring what the keyboard did to the `Scaffold`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

Two things to change while you are in there. Drop `mainAxisAlignment: MainAxisAlignment.spaceBetween`: inside a viewport the available space is infinite, so main-axis alignment has nothing to distribute and silently does nothing. Replace the spacing with explicit `SizedBox` gaps. And if the list is long or built from data, use `ListView` or `ListView.builder` instead so children are built lazily; the trade-offs are the same ones covered in [shrinkWrap vs Expanded vs slivers for long lists](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

You get a bonus from this fix: `EditableText` scrolls the focused field into view through the nearest `Scrollable` ancestor, padded by `TextField.scrollPadding`, which defaults to `EdgeInsets.all(20.0)`. With no scrollable ancestor there is nothing to scroll, which is why the field under your thumb sometimes stays hidden even when the overflow is not visible.

### 2. Fill the screen when there is room, scroll when there is not

The scroll view fix has one cosmetic cost: on a tall screen with the keyboard closed, the content bunches at the top instead of spreading out. The pattern from the [SingleChildScrollView API docs](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) fixes that by giving the `Column` a minimum height equal to the viewport and forcing it to be exactly as tall as its contents when those are bigger:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

Both wrappers are load-bearing. Without `ConstrainedBox` the column shrink-wraps and never fills a tall screen; without `IntrinsicHeight` it takes the minimum height even when its children need more, and you are back to an overflow. `LayoutBuilder` sees the post-keyboard constraints because it sits inside the body slot, so `viewportConstraints.maxHeight` already has the keyboard subtracted.

The docs are blunt about the cost: this lays the subtree out twice, once for intrinsics and once for real. Fine for a login form, bad for a fifty-row settings page.

### 3. Use SliverFillRemaining instead of IntrinsicHeight

If the intrinsics pass shows up in your frame times, express the same intent with slivers. `SliverFillRemaining(hasScrollBody: false)` lets the child fill the remaining viewport, and per its API contract, if the child's extent exceeds the viewport the sliver defers to the child's size rather than overriding it, which is precisely the behaviour you want when the keyboard arrives:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

One rule to remember here: everything directly under `CustomScrollView.slivers` must be a sliver. Putting a `Column` there instead of wrapping it produces [RenderViewport expected a RenderSliver child](/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/).

### 4. resizeToAvoidBottomInset: false, and only on purpose

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

Read the source above again: this sets `minInsets.bottom` to `0.0`, the body keeps its full height, and the keyboard is painted on top of whatever is down there. Nothing is fixed, the overflow warning just has nothing to warn about. It is legitimate on a screen whose input sits in the top third, on a full-bleed map or camera view where resizing would be jarring, or on a chat screen where you drive the inset yourself. It is the wrong answer for a form, because the field the user is typing into is the thing that goes behind the keyboard.

## Gotchas that send people in circles

**`viewInsets.bottom` reads `0` inside the Scaffold body.** This is the single most confusing part of the whole area. `Scaffold` passes the body a modified `MediaQuery`:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

and the body slot is registered with `removeBottomInset: _resizeToAvoidBottomInset`. So with the default settings, a widget inside `Scaffold.body` that reads `MediaQuery.viewInsetsOf(context).bottom` gets `0.0` even while the keyboard is up, because `Scaffold` already consumed that inset by shrinking the body. Manually adding `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` in there does nothing. To read the real value, read it above the `Scaffold`, or set `resizeToAvoidBottomInset: false` and take over the inset handling yourself.

**Modal bottom sheets are the exception.** A `showModalBottomSheet` route is not a `Scaffold` body, so `viewInsets` is intact there and the padding trick is the right fix. Pair it with `isScrollControlled: true`, otherwise the sheet is capped at half the screen:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**A bottomNavigationBar does not stack with the keyboard.** `contentBottom` uses `math.max(minInsets.bottom, bottomWidgetsHeight)`, not the sum. Once the keyboard is taller than the nav bar, the body shrinks by the keyboard height only, and the nav bar itself keeps its slot at the bottom of the scaffold, underneath the keyboard. If you want it gone while typing, hide it yourself: read `MediaQuery.viewInsetsOf(context).bottom` from a `Builder` placed above the `Scaffold` and pass `bottomNavigationBar: inset > 0 ? null : const MyNavBar()`.

**Someone changed `windowSoftInputMode` to `adjustPan`.** If the overflow never appears on Android but the field is covered, or `viewInsets.bottom` stays at `0` forever, check `android/app/src/main/AndroidManifest.xml`. The Flutter template ships `android:windowSoftInputMode="adjustResize"`; a Stack Overflow answer talked someone into `adjustPan` at some point, and now the platform is panning the window instead of reporting an inset.

**Wrapping the offender in `Expanded` is the wrong reflex here.** `Expanded` is the fix for the horizontal case where one greedy child eats a `Row`. In the keyboard case every child is already at its natural size and the total simply exceeds the budget, so `Expanded` either steals space from a widget that needed it or moves the overflow to a sibling. And an `Expanded` that ends up outside a `Flex` gives you [Incorrect use of ParentDataWidget](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) instead.

**Dismiss the keyboard on drag.** Once the body scrolls, add `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` to the scroll view. It costs one line and removes the most common complaint about form screens.

**Lookalike errors.** `Vertical viewport was given unbounded height` is the mirror image, a scrollable inside an unbounded parent, covered in [nesting a ListView inside a Column](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). `RenderBox was not laid out` is usually the second exception after a real layout failure; scroll up to the first one. And if the overflow appears at 1.5x text scale rather than when the keyboard opens, it is the same shape of bug with a different trigger, which the [general RenderFlex overflow post](/2026/05/fix-renderflex-overflowed-in-flutter/) covers in detail.

## Related

- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) is the parent post for the horizontal and text-scale variants of the same assertion.
- [How to nest a ListView inside a Column without an unbounded-height error](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) handles the case where the form itself contains a list.
- [shrinkWrap vs Expanded vs slivers for long lists in Flutter](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) explains why `ListView.builder` beats a `SingleChildScrollView` once the content grows.
- [Fix: RenderViewport expected a RenderSliver child](/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) is the error waiting for you if you take the sliver route.
- [Fix: Incorrect use of ParentDataWidget, Expanded must be inside Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) covers the failure mode of reaching for `Expanded` too eagerly.

## Sources

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), the official page that defines the RenderFlex overflow assertion and its canonical fixes.
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html), which documents the `true` default and its dependence on `MediaQueryData.viewInsets`.
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html), the source of the "viewInsets.bottom corresponds to the top of the keyboard" definition and the split from `padding` and `viewPadding`.
- [scaffold.dart on the stable branch](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart), where `minInsets`, `contentBottom`, and the body's `removeViewInsets` call live.
- [SingleChildScrollView class reference](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), which documents the `LayoutBuilder` plus `ConstrainedBox` plus `IntrinsicHeight` recipe and its cost.
- [SliverFillRemaining class reference](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html), for the exact semantics of `hasScrollBody: false`.
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html), which explains the automatic scroll-into-view behaviour and its `EdgeInsets.all(20.0)` default.
