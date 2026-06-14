---
title: "Fix: Looking up a deactivated widget's ancestor is unsafe in Flutter"
description: "This crash means you called context.of() after the widget left the tree, usually in an async callback or dispose(). Capture the value before the await, or in didChangeDependencies()."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

You used a `BuildContext` to look up an ancestor (`Navigator.of`, `Theme.of`, `ScaffoldMessenger.of`, `MediaQuery.of`, `Provider.of`, an `InheritedWidget`) after the widget that owns that context was removed from the tree. The two usual triggers are an async callback that finishes after the user navigated away, and a lookup inside `dispose()`. The fix is to capture whatever you need from the context before the `await` (or in `didChangeDependencies`), and guard post-await work with `if (!mounted) return;`. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

A `BuildContext` is just a handle to an `Element` in the tree. Once that element is deactivated, walking upward from it can return a stale ancestor or a node that is about to move, so the framework refuses the lookup instead of handing you a wrong answer. This is the same family of lifecycle bug as a [controller used after it was disposed](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/): the object still exists, but it is no longer valid to touch.

## The error in context

The full message Flutter prints looks like this:

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

In release builds the assertion text is stripped and you instead see a bare crash or a `Null check operator used on a null value` further down the stack, because the lookup returned `null`. The assertion fires from `Element._debugCheckStateIsActiveForAncestorLookup` in `package:flutter/src/widgets/framework.dart`, which every `dependOnInheritedWidgetOfExactType` and `findAncestorStateOfType` call runs first in debug mode.

## Why "deactivated" is different from "disposed"

Flutter tears a widget down in two phases. First `deactivate()` runs: the element is detached from its parent and moved to an inactive list, where it might be reactivated this same frame if it was reparented with a `GlobalKey`. Only if it is not reclaimed by the end of the frame does `dispose()` run and the state become permanently dead.

The `mounted` getter on `State` is `false` for both phases. That is the key insight: `mounted` does not mean "not yet disposed", it means "currently attached to the tree". So `mounted` is the right guard for this error, even though the word in the message is "deactivated", not "disposed".

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## Minimal repro: a lookup after await

The most common shape. Tap a button, do async work, then touch the context. If the user backs out during the await, the context is deactivated when the callback resumes.

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

The second repro is a lookup in `dispose()`, which is always unsafe because the element is already detached by then:

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## Fix 1: capture before the await, guard after it

This is the right fix for the async case and the one to reach for first. A `BuildContext` is only safe to read while the widget is mounted, so read everything you need from it synchronously, before the first `await`. Then any object you captured (a `NavigatorState`, a `ScaffoldMessengerState`) stays valid even if the widget leaves the tree, because those state objects outlive the individual element lookup.

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

Two things are doing work here. Capturing `messenger` and `navigator` before the `await` means you never call `.of(context)` on a deactivated context. The `if (!mounted) return;` then skips the UI updates entirely if the user already left, which is almost always what you want anyway. Note that `mounted` must be checked after the `await`, not before, because the await is where the gap opens.

Since Flutter 3.7 there is a `BuildContext.mounted` getter as well, so if you only have a context (not a `State`) you can write `if (!context.mounted) return;`. The `use_build_context_synchronously` lint, on by default in `flutter_lints`, flags exactly the missing guard in this repro, so turn it on and let the analyzer catch these before runtime.

## Fix 2: read inherited widgets in didChangeDependencies

If you genuinely need an inherited value during `dispose()`, for example to deregister from something you found via `.of(context)`, you cannot look it up at dispose time. Capture it earlier. `didChangeDependencies()` runs right after `initState` and again whenever an inherited dependency changes, and the context is fully valid there.

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

This is precisely what the error message tells you to do, modernized: the text still says `dependOnInheritedWidgetOfExactType()`, which is the low-level call that `Theme.of`, `MediaQuery.of`, and friends wrap. You rarely call it directly; calling the typed `.of` accessor in `didChangeDependencies` does the same thing.

## Fix 3: do not look up context inside callbacks you do not control

A subtle variant: the lookup is not in your `dispose()` but in a callback that fires after dispose, such as a `Timer`, a stream listener, an animation status listener, or a `Future.then`. The fix is the same guard, but you also want to cancel the source in `dispose()` so the callback stops firing at all.

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

Cancelling the subscription is the belt; the `mounted` check is the suspenders. Cancel alone usually fixes it, but a callback already in flight when `cancel()` runs can still resume once, so keep the guard. The same pairing applies when you [dispose controllers and other resources](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): release the source, and guard anything that might fire late.

## Gotchas and lookalikes

**`initState` is too early for `.of(context)` with inherited widgets.** You can read `context` in `initState` for some things, but `dependOnInheritedWidgetOfExactType` (and therefore `Theme.of`, `MediaQuery.of`) is not allowed there because the element is not yet wired to its inherited dependencies. Move those reads to `didChangeDependencies`. This throws a different assertion ("dependOnInheritedWidgetOfExactType was called before initState completed"), so if your message mentions `initState`, you are looking at the early-lookup variant, not the deactivated one.

**`Navigator.pop` followed by a context use.** A frequent FlutterFlow and hand-rolled-form pattern is `Navigator.pop(context)` and then, on the next line, another `.of(context)` call. After the pop, the route's element starts deactivating, so the second lookup can throw. Capture the navigator or messenger before popping.

**`GlobalKey` reparenting.** If you move a subtree with a `GlobalKey` and something in it does an ancestor lookup during the reparent frame, you can hit this transiently. It is rarer; the fix is to defer the lookup to after the frame with `WidgetsBinding.instance.addPostFrameCallback`, then re-check `mounted`.

**Release builds hide it.** Because the message comes from an `assert`, it only prints in debug. In profile and release the lookup silently returns `null` and you crash later with a null dereference. If you see a `Null check operator used on a null value` only in release and only after navigation, suspect this. The [`setState() called during build` guard](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) behaves the same way: a debug-only assert hiding a release-mode null.

**Riverpod's version of this.** If you use a `WidgetRef` instead of `BuildContext`, the equivalent crash is [`Cannot use "ref" after the widget was disposed`](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Same root cause, same fix: read before the await, guard after. Reaching for a structured async pattern like [`AsyncValue` for loading and error states](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) sidesteps most of these manual guards because the framework tracks the widget lifecycle for you.

## The one rule that prevents all of these

Treat `BuildContext` as valid only between `build` and the next suspension point. The moment you `await`, the context may be gone when you return, so either capture what you need first and guard with `mounted`, or restructure so the lookup never crosses an async boundary. Once that habit is in place, the "deactivated widget's ancestor" crash, the disposed-controller crash, and the disposed-ref crash all stop appearing for the same reason.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) and [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html), Flutter API docs.
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html), Flutter API docs (the call named in the error message).
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462), the canonical issue tracing it to `Navigator.push` inside an async callback.
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously), Dart linter rules, which flags the missing guard statically.
