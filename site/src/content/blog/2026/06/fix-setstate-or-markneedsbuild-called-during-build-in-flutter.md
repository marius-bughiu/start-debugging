---
title: "Fix: setState() or markNeedsBuild() called during build in Flutter"
description: "This error means you mutated state while Flutter was building. Move the setState out of build, or defer it with addPostFrameCallback. Here is why it happens and the right fix."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

You called `setState()` (or something that calls `notifyListeners()`, `markNeedsBuild()`, or `Navigator.push`) while Flutter was in the middle of its build phase. The fix is to not change state during `build`. If the trigger is genuinely a synchronous callback that fires mid-build, defer the mutation to the next frame with `WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))`. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

The error is a guardrail, not a glitch. Flutter builds parents before children in a single synchronous pass. Marking a widget dirty mid-pass would ask the framework to schedule a rebuild for something it may have already visited, which it cannot honor in the current frame. So it throws instead of silently dropping your update.

## The error in context

The full message Flutter prints to the console looks like this:

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

The two lines that matter are at the bottom. "The widget on which setState() ... was called" is what you are trying to rebuild. "The widget which was currently being built" is where the offending call originated. The gap between those two widgets is the bug.

## Why this happens

There are four common triggers, in rough order of how often they bite:

A listener notifies during build. A `ChangeNotifier`, `ValueNotifier`, or provider calls `notifyListeners()` from inside a method you invoked while reading it in `build`. The notification synchronously asks every listening widget to rebuild, but you are already building one of them.

You called `setState` directly in `build`. Usually by accident: a method that computes a value also flips a flag and calls `setState`, and you call that method from `build`.

You read a provider with `listen: true` during a build that also mutates it. `Provider.of<T>(context)` (listening) registers a dependency. If the same frame writes to that provider, the write tries to rebuild the dependent that is still building.

You navigated or showed a dialog from `build`. `Navigator.push`, `showDialog`, and `Scaffold.of(context).showSnackBar` all mark ancestors dirty. Calling them from `build` (instead of from an event handler) trips the same assertion.

The unifying rule from the Flutter team is simple: `build` must be a pure function of widget configuration and state. It returns a widget tree and does nothing else. Side effects that change state belong in lifecycle methods (`initState`, `didChangeDependencies`) or event handlers (`onPressed`, `onTap`), never in `build`.

## How to find the offending call

The console message names two widgets, but the line you need to change is usually not in either of them. It is in whatever ran synchronously between them. Read the message bottom-up:

1. "The widget which was currently being built" tells you the build that was in flight. Search your code for that widget's `build` method, or for the `builder` callback if it is a `Consumer`, `Builder`, `LayoutBuilder`, or `ValueListenableBuilder`.
2. Inside that build, find every method call that is not a pure read. A getter that increments a counter, a method named `load`, `refresh`, `fetch`, or `update`, anything that touches a `ChangeNotifier`. That call is your suspect.
3. If nothing in the build looks impure, the trigger is a listener. Look at the "dispatching notifications for X" line at the very top: `X` is the notifier that fired. Find where `X.notifyListeners()` is called and trace back to what invoked it during this frame.

In debug builds, the stack trace under the message points directly at the `notifyListeners` or `setState` call site. In release builds the assertion is compiled out, so the bug manifests as a dropped update or a stale frame instead of a crash. That is exactly why you want to fix the cause, not silence the symptom: the symptom only exists in debug.

## A minimal repro

This widget throws on its first frame. The model notifies its listeners from a method that runs while a `Consumer` is building.

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

The `Consumer` is building. Its `builder` calls `countAndTrack()`, which calls `notifyListeners()`, which asks the `Consumer` to rebuild while it is still building. Flutter throws.

The same shape appears without Provider. Any `addListener` callback that ends up calling `setState` synchronously during a parent build will do it.

## Fix, in detail

The fixes are ordered by how much I recommend them. The first one is almost always the real answer.

### 1. Move the state change out of build (recommended)

Do not mutate during build. Compute derived values in `build`, but perform the actual state change in a lifecycle method or an event handler. In the repro, the mutation belongs in `initState`, not in the `builder`:

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` gets the model without subscribing, so it is safe in `initState`. `context.watch<T>()` subscribes and is safe in `build` because it only reads. The write happens once, before the frame, and the read drives rebuilds afterward.

### 2. Defer the mutation with addPostFrameCallback

Use this when the trigger is genuinely outside your control: a third-party callback, a stream event that lands mid-build, or a `LayoutBuilder` that needs to react to a measured size on the same frame. `WidgetsBinding.instance.addPostFrameCallback` runs your closure after the current frame is fully built and painted, so `setState` is legal again.

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

Two guardrails make this safe. The `mounted` check prevents a `setState after dispose` crash if the widget left the tree before the callback ran. And the callback must be conditional (gated by `_needsRefresh` here), or you schedule a fresh rebuild every frame and burn the CPU in an infinite loop. `addPostFrameCallback` is a deferral, not a license to rebuild on every paint.

### 3. Split a synchronous notify into a microtask

If you own the notifier and a method legitimately needs to notify, but you cannot guarantee it is never called during build, push the notification off the synchronous path:

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

This is a last resort. It hides the design smell (a getter with a side effect) rather than removing it, and microtasks can still race with disposal. Prefer fix 1.

## Gotchas and variants

`setState() called after dispose()`. Different assertion, related cause. You called `setState` from an async callback (a `Future.then`, a `Timer`, a stream listener) that completed after the widget was removed from the tree. Guard every async `setState` with `if (!mounted) return;`. See the disposal patterns in [the controller-disposal guide](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`setState` in `initState`. Calling `setState` synchronously in `initState` is not an error, but it is pointless: the first build has not happened yet, so the state is already going to be read. Just assign the field directly. Flutter does not throw here, unlike the build-phase case.

`Navigator.push` from `build`. A frequent variant of this error. If you want to navigate as a side effect of state (say, redirect when a user is logged out), do it in `addPostFrameCallback` or, better, with a routing package that models redirects declaratively rather than imperatively from `build`.

`FutureBuilder` / `StreamBuilder` that rebuilds forever. If the `future` or `stream` is created inside `build`, every rebuild makes a new one, which completes, which calls `setState` internally, which rebuilds. Create the future or stream once in `initState` and store it in a field. This is not strictly the same exception, but it lands you in the same "I am rebuilding during a rebuild" territory and is a common cause of [Flutter jank you can spot in DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

Riverpod users. Reading a provider with `ref.watch` inside a callback that runs during build, then writing to it in the same synchronous pass, hits the same wall. Riverpod's `AsyncValue` plus a `Notifier` keeps the read and the write on separate paths; see [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) for the pattern.

The deeper point: `build` is called often, unpredictably, and possibly many times per frame. Anything you put there runs on Flutter's schedule, not yours. Reads are fine because they are idempotent. Writes are not, because they change what the next read returns, and Flutter has no safe place to absorb that change mid-build. Keep `build` pure and the error disappears for good. The same discipline keeps unrelated bugs like [RenderFlex overflow](/2026/05/fix-renderflex-overflowed-in-flutter/) easier to reason about, because your layout is a clean function of state rather than a moving target. If your widget genuinely needs to react to async data, model that data as state and let [graceful error and loading handling](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) drive the rebuilds for you.

## Sources

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- the contract for when setState is legal.
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- scheduling work after the current frame.
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- when listeners are called synchronously.
