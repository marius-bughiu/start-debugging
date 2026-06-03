---
title: "Fix: A TextEditingController was used after being disposed in Flutter"
description: "This crash means code touched a controller after dispose() ran. Guard async callbacks with a mounted check, and never dispose a controller you do not own."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

Something read from or wrote to a `TextEditingController` after its `dispose()` had already run. The usual culprit is an async callback (a `Future.then`, `await`, `Timer`, or stream listener) that completes after the user left the screen and the `State` was torn down. Guard the post-await code with `if (!mounted) return;` before touching the controller. The other common cause is ownership confusion: a child widget disposed a controller it was handed but does not own. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

The error is not specific to `TextEditingController`. The same message appears for any `ChangeNotifier` (`ScrollController`, `FocusNode`, `AnimationController`, `ValueNotifier`, a Provider's model) because the assertion lives in `ChangeNotifier` itself. The runtime type in the message just tells you which one you reached for too late.

## The error in context

The full message Flutter throws looks like this:

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

The stack frame just under the `ChangeNotifier` frames is the line in your code. It names the operation that touched the dead controller: `text=`, `.text`, `addListener`, `clear()`, or `.selection`. That frame is where you fix it, but the reason it fired is somewhere earlier in time, when `dispose()` ran before that line.

## Why this happens

There are four causes, in rough order of how often they bite.

An async callback outlived the widget. You started an `await`, a `Future.then`, a `Timer`, or a `stream.listen` while the screen was alive, the user navigated away (which disposes the `State` and the controller), and then the callback completed and touched the controller. This is by far the most common cause, because it only crashes when timing lines up: it passes every time the response is fast and crashes when the user is quick or the network is slow.

A child disposed a controller it does not own. A parent created the controller and passed it down; the child called `dispose()` on it in its own `dispose()`. Now the parent (or a sibling, or the next rebuild) uses a controller the child already killed. Ownership is the inverse of the leak problem: dispose a controller you do not own and you get this crash, forget to dispose one you do own and you get a memory leak.

A state-management layer disposed it. If the controller lives in a Riverpod `autoDispose` provider, a GetX controller, or a `ChangeNotifier` that the framework tore down, the widget still holding a reference will hit a disposed instance. Riverpod's `autoDispose` is a frequent trigger: the provider is recomputed or disposed when no longer watched, taking the controller with it, while a stale closure still points at the old one.

`didUpdateWidget` disposed the old one too eagerly. When a controller depends on a `widget` property, you dispose the old controller and create a new one on update. If a pending callback captured the old controller, it now touches a disposed instance.

The underlying contract, from the Flutter [ChangeNotifier API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html): once `dispose()` is called, the object is defunct and any further use throws in debug builds. The assertion is compiled out of release builds, so in release the same code does not crash but reads stale or null state instead. That is why you fix the cause, not silence the assert.

## A minimal repro

This widget crashes when you leave the screen before the fetch returns. It compiles and runs, and it passes when the network is fast.

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

Push this screen, then pop it within half a second. `dispose()` runs, `_controller.dispose()` kills the controller, the `Future` completes, and `_controller.text = ...` throws. The crash is timing-dependent, which is exactly why it survives code review and ships.

## Fix, in detail

The fixes are ordered by how much I recommend them. Pick the one that matches your cause.

### 1. Guard async callbacks with mounted (recommended)

Every place an `await` (or any deferred callback) is followed by code that touches the controller or calls `setState`, check `mounted` first. `mounted` is `false` once the `State` has been disposed, so the guard short-circuits before the controller is touched.

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

The rule: after every `await` in a `State` method, the next line that touches `this`, the controller, or `setState` must be preceded by a `mounted` check. There is one `await` here so there is one guard. If a method has two awaits and touches the controller after each, it needs two guards. The Dart analyzer's `use_build_context_synchronously` lint catches the `BuildContext` version of this mistake; treat a controller exactly the same way.

For a `Timer` or a `stream.listen`, the guard goes inside the callback:

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

Better still, cancel the subscription or timer in `dispose()` so the callback never fires after teardown. Cancelling is cleaner than guarding, because a guarded-but-uncancelled subscription still wakes up, allocates, and runs the guard on every event for a screen the user already left. See the disposal ordering in [the controller-disposal guide](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 2. Fix ownership: do not dispose what you do not own

If the crash is not async, it is almost always ownership. The rule is one line: whoever creates the controller disposes it, and nobody else. A widget that receives a controller through its constructor must never dispose it.

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

If `EmailField` were a `StatefulWidget` and disposed `widget.controller`, the parent's later use of `_email` would throw this exact error. The fix is to delete that `dispose()` call from the child. The mirror-image bug (the parent forgetting to dispose) is a leak, covered in the disposal guide above.

### 3. Let the state-management layer own disposal

When a controller is hoisted into a Riverpod provider, a GetX controller, or any object outside the widget, disposal moves with it. The widget must not dispose a controller it borrowed from a provider, and the provider's `onDispose` (Riverpod) or `onClose` (GetX) is where the `dispose()` call now lives. With Riverpod `autoDispose`, keep the provider alive while the screen needs it (use `ref.keepAlive()` or a non-`autoDispose` provider) so it is not recomputed out from under a widget that still holds the controller. Moving lifecycle ownership during a state-management migration is exactly where this breaks silently; I wrote up [migrating a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) as a deliberate, step-by-step move for that reason.

### 4. Recreate carefully in didUpdateWidget

If a controller depends on a `widget` property and you swap it in `didUpdateWidget`, dispose the old one and assign a fresh one, and make sure no pending callback still references the old instance:

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

Any async work started against the old controller must check `mounted` (and ideally be cancelled) before it lands, or it will write to the disposed instance you just replaced.

## Gotchas and variants

`setState() called after dispose()`. The same root cause, a different assertion. An async callback that calls `setState` after teardown throws this instead of the controller message, because `setState` checks `mounted`-equivalent state internally. The fix is identical: guard with `if (!mounted) return;`. It often travels together with the controller crash, since the same callback usually both writes the controller and calls `setState`. See [setState or markNeedsBuild called during build](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) for the build-phase cousin of this family.

`A ScrollController was used after being disposed`, `A FocusNode was used after being disposed`, `An AnimationController was used after being disposed`. Same assertion, same fixes. The message names whichever `ChangeNotifier` you touched; the diagnosis (async-after-dispose or wrong owner) does not change.

The crash only happens sometimes. That is the signature of the async cause, not a flaky framework. A fast network hides it; a slow network or a fast user exposes it. Do not dismiss an intermittent version of this error as noise. Reproduce it by adding an artificial delay before the controller write and popping the screen during the delay.

It throws in tests but not in the app. Widget tests tear down widgets aggressively and pump frames deterministically, so a missing `mounted` guard that hides in a real app surfaces immediately under `testWidgets`. That is the test doing its job. The Flutter team tracks one variant of this in [flutter/flutter issue 98965](https://github.com/flutter/flutter/issues/98965), where pending timers in tests touch disposed controllers; the fix there is also to cancel the timer in `dispose()`.

Reusing one controller across two `TextField`s on different routes. A controller is single-owner. If you stash a `TextEditingController` in a long-lived singleton and hand it to a field on screen A and another on screen B, disposing one screen disposes the controller out from under the other. Give each field its own controller, or move the text into shared state and let each field own a local controller.

The single discipline that removes this whole class of bug: a controller has exactly one owner, that owner disposes it exactly once, and every async path that touches it is gated by a `mounted` check or cancelled before teardown. Wire that into your `dispose()` reflex and the error stops appearing. If you also want to catch the opposite failure (controllers that are never disposed at all), the [leak_tracker workflow in the disposal guide](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) will hold you to both sides of the contract, and modelling your async data as state with [graceful loading and error states](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) keeps the dangerous post-await writes off the controller entirely.

## Related

- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) is the mirror image: this crash is using a disposed controller, that guide is forgetting to dispose one.
- [Fix: setState() or markNeedsBuild() called during build in Flutter](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) shares the `mounted`-guard fix for async callbacks.
- [How to handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) is where the slow-response timing that triggers this crash usually comes from.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) keeps async results in state instead of writing them straight to a controller after an await.

## Sources

- [ChangeNotifier, Flutter API reference](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- where the "used after being disposed" assertion is defined.
- [TextEditingController, Flutter API reference](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- the controller's lifecycle and `dispose()` contract.
- [State.mounted, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- the flag that tells you whether the controller is still alive.
- [flutter/flutter issue 98965](https://github.com/flutter/flutter/issues/98965) -- the error surfacing in widget tests from pending timers.
