---
title: "How to Dispose Controllers in Flutter to Avoid Memory Leaks"
description: "AnimationController, TextEditingController, and ScrollController hold resources that Dart's GC cannot reclaim until you dispose them. Here is the correct pattern, the ordering rules, and how to catch leaks before they ship."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
---

If a controller exposes a `dispose()` method, you must call it from your `State.dispose()`, and you must do it before `super.dispose()`. Concretely: create the controller in `initState` (or as a `late final` field), call `controller.dispose()` in `dispose()`, and for `AnimationController` add a `SingleTickerProviderStateMixin` so the ticker stops when the widget leaves the tree. Skipping any of this leaves a `Ticker`, a listener list, or a stream subscription alive and reachable, which pins the whole widget subtree in memory. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

Garbage collection does not save you here. Dart's GC reclaims objects that are no longer reachable, but a running `AnimationController` is reachable from the `SchedulerBinding`'s ticker list, and a `TextEditingController` you handed to a `TextField` is reachable from the listener graph as long as something holds the controller. The leak is not a GC bug. It is an ownership bug: you created a resource and never released it.

## Why a controller outlives its widget

A `StatefulWidget` is cheap and disposable. Flutter rebuilds the widget object constantly. The `State` object is the thing with a lifecycle, and the controllers you create belong to that `State`. When the widget is removed from the tree, Flutter calls `State.dispose()` exactly once. That call is your only chance to release native and framework resources.

Three categories of controller leak in distinct ways:

`AnimationController` registers a `Ticker` with the `SchedulerBinding`. The ticker fires a callback on every frame while the animation is running. Until you dispose the controller (which disposes the ticker), the `SchedulerBinding` holds a reference to the ticker, the ticker holds a reference to your callback, and your callback closes over `this`, your `State`, and through it the entire subtree. In debug builds Flutter actually asserts on this: if you forget the `dispose`, you get `AnimationController.dispose() called more than once` or a ticker-still-active assertion when the widget is torn down.

`TextEditingController`, `ScrollController`, and `FocusNode` are `ChangeNotifier`s (or hold one). They maintain a list of listeners. A `TextField` adds itself as a listener so it can repaint when the text changes. If you also call `controller.addListener(...)` yourself and never dispose, the controller, its listener list, and every closure in that list stay alive. The controller holds the listeners, not the other way around, so the GC cannot collect any of them.

`StreamSubscription` and `Timer` are the same shape without the `dispose()` name: you call `subscription.cancel()` and `timer.cancel()`. A live subscription is referenced by the stream, which keeps your `onData` callback alive.

The unifying rule, straight from the Flutter team's [State.dispose API docs](https://api.flutter.dev/flutter/widgets/State/dispose.html): "If a State's build method depends on an object that can itself change state, ... subscribe to that object during initState ... and unsubscribe in dispose."

## A minimal repro that leaks

Here is a widget that leaks all three resource types. It compiles and runs. It just never lets go.

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Push and pop this screen 50 times and you have 50 tickers firing every frame, 50 stream subscriptions delivering events, and 50 detached widget subtrees the GC will never touch. The animation tickers alone will visibly degrade frame times, because every one of them still wants to run on every vsync.

## The disposal pattern, in full

The fix is mechanical once you internalize it. Mirror every resource you create with a release call in `dispose()`, and put `super.dispose()` last.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

A few things in that code are load-bearing, so it is worth being explicit about each.

### Create in initState, not in build

`build` runs many times. If you write `final _text = TextEditingController()` as a field initializer with a non-`late` value, you are fine because field initializers run once. But if you ever construct a controller inside `build`, you allocate a fresh one on every rebuild and orphan the previous one immediately. Construct controllers in `initState` or as `late final` fields, never in `build`.

### Why super.dispose() goes last

The convention is the inverse of `initState`. In `initState` you call `super.initState()` first, then set up your state. In `dispose` you tear down your state first, then call `super.dispose()` last. The base `State.dispose()` marks the object as defunct; touching your own fields after that is a bug, and the framework's debug build will flag a `dispose` called on an already-disposed `State`. Tearing down your resources before handing control back to the base class keeps the ordering sane.

### removeListener before dispose, or just dispose

If you called `addListener` on a controller, you can either call `removeListener` with the same callback before `dispose`, or rely on `dispose()` to drop the entire listener list. Disposing a `ChangeNotifier` clears its listeners, so an explicit `removeListener` right before `dispose` of the same object is redundant. The reason to keep the explicit `removeListener` is when you added yourself as a listener to a controller you do not own (one passed in from a parent). You must remove your listener from that controller in `dispose`, because you are not the one disposing it.

## AnimationController needs a TickerProvider

`AnimationController` is the one controller that needs more than a `dispose` call: it needs a `vsync` argument, which is a `TickerProvider`. The `TickerProvider` is what binds the controller's ticker to the screen's refresh rate and, crucially, to the widget lifecycle.

Use `SingleTickerProviderStateMixin` when the `State` owns exactly one `AnimationController`. Use `TickerProviderStateMixin` when it owns several. The single-ticker mixin is a small optimization and it asserts if you accidentally create two controllers against it, which is a useful guard.

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

If your animation is simple, the cleanest way to never leak a controller is to not own one. Implicit animation widgets such as `AnimatedContainer`, `AnimatedOpacity`, and `TweenAnimationBuilder` manage their own controllers internally and dispose them for you. Reach for an explicit `AnimationController` only when you need to drive, reverse, repeat, or chain the animation yourself. Profiling animation jank is a separate skill: if your animations are smooth but the app still stutters, the cause is usually work on the UI thread, which I cover in [the guide on profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

## Who owns the controller decides who disposes it

The single most common real-world leak (and the most common double-dispose crash) comes from unclear ownership. The rule: whoever creates the controller disposes it. If a controller is created in widget A and passed into widget B, then A disposes it, and B must not.

This matters because Flutter widgets frequently accept a controller as a constructor parameter precisely so a parent can control them. `TextField`, `ListView`, `PageView`, and `TabBar` all take an optional controller. When you pass one in, you keep the dispose responsibility:

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

If `NameField` were to dispose a controller it did not create, the parent would later try to use a disposed controller and crash with `A TextEditingController was used after being disposed`. That exact error has its own diagnosis, but the root cause is almost always two widgets fighting over one controller's lifecycle.

The opposite mistake hoists a controller into a state-management layer (a `ChangeNotifier`, a Riverpod `Notifier`, a GetX controller) and then forgets that the layer now owns disposal. If you move a `TextEditingController` out of a `State` and into a Riverpod provider, the provider's `onDispose`/`dispose` is where the `controller.dispose()` call now lives, not the widget. When you are restructuring lifecycle ownership during a state-management migration, this is exactly the kind of thing that breaks silently, which is part of why I wrote up [migrating a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) as a careful, step-by-step move rather than a find-and-replace.

## Edge cases that bite

**Conditional creation.** If a controller is only created on some code paths, make the field nullable and guard the dispose: `_optional?.dispose();`. Do not leave a `late final` controller uninitialized and then call `dispose` on it, which throws `LateInitializationError`.

**Recreating a controller on widget update.** If your controller depends on a `widget` property, you may need to dispose the old one and create a new one in `didUpdateWidget`. The pattern is: in `didUpdateWidget`, compare `oldWidget.x` to `widget.x`, and if they differ, `_controller.dispose()` then assign a fresh one. Forgetting the dispose in `didUpdateWidget` leaks one controller per relevant prop change.

**GlobalKey and controllers are different things.** A `GlobalKey` does not need disposing, but a controller reached through a key still does. Do not conflate the two.

**Hot reload hides leaks.** Hot reload preserves `State`, so a forgotten `dispose` may not surface during development. You only notice when the screen is actually pushed and popped, or under the leak tracker. Test the real navigation path, not just hot reload.

**Heavy work in a controller callback belongs off the UI thread.** If your `ScrollController` or `AnimationController` listener does meaningful computation, that work runs on the UI isolate and competes with rendering. Move it to a background isolate; I walk through that in [writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

## Catching leaks before they ship

You do not have to find these by reading code. Flutter ships `leak_tracker`, and since Flutter 3.x the test framework integrates with it so disposal leaks fail your widget tests automatically when leak tracking is enabled. The Flutter team documents the workflow in the official [leak tracking guide](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md). The mental model: every disposable object is expected to be disposed; if the GC collects one that was never disposed, that is a "not disposed" leak, and if one is disposed but never collected, that is a "not GCed" leak. Both are reported with the allocation stack trace, so you get pointed straight at the `initState` that created the orphan.

For a running app, open DevTools and use the Memory view. Push and pop the suspect screen several times, force a GC, and watch the instance count of `AnimationController`, `TextEditingController`, or your `State` class. If the count climbs and never falls, you have a leak, and the retaining-path view shows you what is still pointing at the object. The same DevTools session is where you would investigate frame timing, which overlaps with the jank profiling workflow.

The discipline is simple enough to state in one line and worth turning into a code-review reflex: for every `Controller`, `FocusNode`, `StreamSubscription`, and `Timer` you create in a `State`, there is exactly one matching release call in `dispose()`, and `super.dispose()` is the last statement in the method. Wire `leak_tracker` into your widget tests and the framework will hold you to it.

## Related

- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) covers the Memory and Performance views you use to confirm a leak.
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) is where controller callbacks that do real work should run.
- [How to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) shows how disposal ownership moves when you change state-management layers.
- [Fix: RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) is the other classic Flutter bug you hit while building the same screens.

## Sources

- [State.dispose, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController, Flutter API reference](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController, Flutter API reference](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [leak_tracker overview, dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Use the Memory view, Flutter DevTools docs](https://docs.flutter.dev/tools/devtools/memory)
