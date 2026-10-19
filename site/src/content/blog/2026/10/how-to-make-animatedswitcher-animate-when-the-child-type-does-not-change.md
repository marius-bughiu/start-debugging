---
title: "How to Make AnimatedSwitcher Animate When the Child Widget Type Does Not Change in Flutter"
description: "AnimatedSwitcher only transitions when Widget.canUpdate says the new child is a different widget, so Text to Text with no key just updates in place. Here is the one-line fix, where the key has to sit, why UniqueKey is a trap, the slide-direction bug caused by a static transitionBuilder, and the layout jump from the default Stack, all verified with widget tests on Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
---

**Short answer:** give the direct child of `AnimatedSwitcher` a key that changes whenever the content changes, usually a `ValueKey` built from the data you are displaying: `Text('$count', key: ValueKey<int>(count))`. `AnimatedSwitcher` decides whether to run a transition with `Widget.canUpdate`, which compares only `runtimeType` and `key`. Two `Text` widgets with no key are "the same widget" as far as the framework is concerned, so the old one is updated in place and nothing animates. Everything below was verified with widget tests on Flutter 3.44.8 (Dart 3.12.2), and the `_AnimatedSwitcherState` source is byte-identical on the current `stable` branch.

The rest of this post shows the exact line in the framework that makes this happen, a minimal repro with test output, where the key must sit (a key one level down does nothing), why `UniqueKey` is the wrong fix, and three gotchas that show up right after you get the transition working: slide transitions that move in the wrong direction, content that jumps to the center, and children that lose their state.

## The one comparison AnimatedSwitcher makes

`AnimatedSwitcher` is a `StatefulWidget` that keeps a "current entry" (the child plus its own `AnimationController`) and a set of outgoing entries that are still fading out. When the parent rebuilds it with a new `child`, `didUpdateWidget` runs this check, straight from `packages/flutter/lib/src/widgets/animated_switcher.dart`:

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

And `Widget.canUpdate` is one line:

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

Notice what is not compared: the text, the color, the image URL, any field at all. A transition starts in exactly three cases: the child goes from `null` to non-null, it goes from non-null to `null`, or the new child has a different runtime type or a different key. If you go from `Text('1')` to `Text('2')`, none of these hold, so the `else` branch swaps the widget into the existing entry and the user sees an instant change. The API docs say this plainly, but the symptom ("my AnimatedSwitcher does nothing") rarely makes people look there. If you want the general theory behind this comparison, I covered it in [what a Flutter Key is and when omitting it causes bugs](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/).

## A minimal repro you can run as a test

The fastest way to see whether a transition is running is to count `FadeTransition` widgets in the middle of the animation. The default `transitionBuilder` wraps every entry, incoming and outgoing, in one `FadeTransition`, so one means "no transition" and two means "cross-fade in progress".

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

Without a key there is one `FadeTransition` 100 ms into a 300 ms animation, which means no animation exists. With `ValueKey` there are two, and after `pumpAndSettle` the outgoing entry has been disposed and removed.

## Fixing it in a real widget

Here is the same fix in an app widget. The key goes on the widget you pass as `child`, and it is derived from the value that should trigger the transition:

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

The same pattern covers every "same type, different content" case people hit:

- Swapping images: `Image.network(url, key: ValueKey(url))`.
- Swapping icons: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`.
- Switching between states of a model: `key: ValueKey(user.id)` on a profile card, so editing the same user does not animate but selecting a different user does.
- Loading, error and data branches that happen to return the same widget type (for example three `Center` widgets): give them `ValueKey('loading')`, `ValueKey('error')`, `ValueKey('data')`. If your async state comes from Riverpod, this pairs naturally with [showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

Choosing what goes in the key is choosing when the animation fires. A key built from `count` animates on every increment. A key built from `count ~/ 10` animates only when the tens digit changes, while the inner text still updates in place.

## The key has to be on the direct child

`canUpdate` only ever looks at `widget.child`, the widget you hand directly to `AnimatedSwitcher`. A key on something nested inside it is invisible to that comparison:

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

In my test this produced one `FadeTransition` mid-animation, the same as no key at all. The outer `Padding` has no key and the same type each time, so the switcher updates it in place, and the inner `Text` gets a fresh element by itself without any transition. Move the key to the `Padding` (or to whatever your top-level widget is, often a `Container`, `Card`, or your own `StatelessWidget`) and it works.

This also bites when the child is your own widget class:

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

Passing `key` through `super.key` in `StatusBadge`'s constructor is enough. Putting a key on something inside `StatusBadge.build` is not.

## Why UniqueKey is the wrong fix

The first answer many people find is `key: UniqueKey()`. It does make the switcher animate, but it animates on every rebuild of the parent, not just when the content changes:

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

Same text, a full cross-fade. In a real screen the parent rebuilds for reasons unrelated to the switched content: a `MediaQuery` change when the keyboard opens, a theme change, an unrelated `setState`, a provider notifying. Each one restarts the transition, and each one throws away the child's element and state. The opposite mistake is a constant key, such as `ValueKey('label')` on a `Text` whose string changes. That key never changes, so `canUpdate` is true and nothing animates. My test confirmed one `FadeTransition` and the new text shown instantly. Derive the key from the data, every time.

## Rapid switches and null children

Two behaviours that are worth knowing so you do not mistake them for bugs:

1. If the child changes again before the previous transition ends, the switcher does not cancel anything. The current entry is moved to the outgoing set and reversed, so several children can be fading out at once. Switching 1 to 2 to 3 within 100 ms left three `FadeTransition` widgets in the tree. This is also why the same key can come back safely: every transition is wrapped in a `KeyedSubtree` keyed by an internal counter (`_childNumber`), so a new child with key `A` is never confused with an outgoing child that also had key `A`.
2. Setting `child: null` is a valid way to animate content out. `hasNewChild != hasOldChild` triggers the transition, the old child fades out, and nothing fades in.

## Gotcha: slide transitions that go the wrong way

Once the cross-fade works, the next request is usually a horizontal slide: the new value slides in from the right, the old one slides out to the left. The naive version slides both children from and to the right, because the outgoing child's controller simply runs in reverse along the same tween. The standard trick is to check in `transitionBuilder` whether the child being wrapped is the current one:

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

Here is the subtle part. `AnimatedSwitcher` only re-runs `transitionBuilder` for outgoing entries when `widget.transitionBuilder != oldWidget.transitionBuilder`. A function literal written inline in `build`, such as `transitionBuilder: (c, a) => _slide(c, a)`, creates a new closure object on every build, so the comparison is true, every entry is rebuilt with the latest `_count`, and the old child is correctly flagged as outgoing. A method tear-off like `transitionBuilder: _slide`, or a builder stored in a field, can compare equal across builds, so the outgoing entry keeps the transition it was built with when it was incoming. I ran both variants and read the `SlideTransition` offsets halfway through:

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

With the stored function the old child slides back out to the right, on top of the new one. If you write a direction-aware `transitionBuilder`, pass it as an inline closure (or otherwise make sure it is a new object whenever the key changes), and add a test like the one above so a refactor to a tear-off does not silently break it.

## Gotcha: content jumps to the center or the size snaps

The default `layoutBuilder` puts the outgoing children and the current child in a `Stack` with `alignment: Alignment.center`. Two visible side effects:

- Left-aligned content, for example a label in a `Row` or a `ListTile` subtitle, jumps to the center while the transition runs.
- The `Stack` is as large as the largest child, so when a long string is replaced with a short one, the space shrinks only after the old child is gone.

Both are fixed with a custom `layoutBuilder`, optionally wrapped in `AnimatedSize` to smooth the size change:

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

Keep `previousChildren` before `currentChild` so the incoming widget paints on top, which matches the default.

## Gotcha: the child's state is thrown away

A changed key means a new element. Any `State` below the switched child, such as a `TextField` controller created in `initState`, a scroll position, or an expansion flag, is created fresh for the incoming child. In my test, the element before and after a key change was a different object. That is usually what you want for "show a different thing", but it is the wrong tool for "animate a property of the same thing". If the user is typing in a field and you key it by the text, every keystroke recreates the field and drops focus.

For property changes on the same widget, use an implicit animation instead: `AnimatedDefaultTextStyle`, `AnimatedContainer`, `AnimatedOpacity`, or `TweenAnimationBuilder` for an arbitrary value. These keep the element and interpolate the property. `AnimatedSwitcher` is for replacing content, and the key is how you tell it that the content was replaced. If you need the transition to cross screens rather than happen inside one, look at [a Hero animation between two screens](/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) or [custom page transitions](/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/) instead.

## Checklist when AnimatedSwitcher does nothing

1. Put a key on the widget passed directly as `child`, not on something inside it.
2. Derive the key from the data that should trigger the transition, usually `ValueKey(value)`, never `UniqueKey()` created in `build`.
3. Check that the key actually changes: a constant `ValueKey('x')` is the same as no key for this purpose.
4. Make sure the `AnimatedSwitcher` itself is not recreated: if an ancestor changes type or key, the switcher's own state is rebuilt from scratch and the first child is shown without animation (`initState` calls `_addEntryForNewChild(animate: false)`).
5. If you use a direction-aware `transitionBuilder`, pass it as an inline closure so outgoing entries are rebuilt.
6. Fix alignment and size with a custom `layoutBuilder` and `AnimatedSize`.

### Read next

- [What is a Flutter Key and when does omitting it cause bugs?](/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [How to add a Hero animation between two screens in Flutter](/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Migrate custom page transitions after the Flutter page transition builders reorganization](/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Fix: setState() or markNeedsBuild() called during build in Flutter](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## Sources

- [AnimatedSwitcher class, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart on the stable branch, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Implicit animations, Flutter docs](https://docs.flutter.dev/codelabs/implicit-animations)
