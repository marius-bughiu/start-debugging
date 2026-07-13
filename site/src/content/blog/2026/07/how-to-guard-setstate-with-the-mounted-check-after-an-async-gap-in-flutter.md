---
title: "How to guard setState with the mounted check after an async gap in Flutter"
description: "After an await, the widget may already be disposed, and calling setState throws. Guard the resume with if (!mounted) return; and, better, cancel the work that triggers it. The full pattern for Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
---

The rule is one line: inside a `State`, never call `setState` after an `await` without first checking `if (!mounted) return;`. An `await` hands control back to the event loop, the user can pop the screen while your async work runs, and when your code resumes the widget may already be disposed. Calling `setState` on a disposed `State` throws `setState() called after dispose()`. The `mounted` getter tells you whether the `State` is still in the tree, so guarding the resume with it makes the crash impossible. Even better, cancel the timer, subscription, or request that would call `setState` at all, so the callback never fires on a dead widget. This guide uses Flutter 3.44 (current stable, 2026) and Dart 3.x.

`mounted` is a getter on `State<T>`. It is `true` from the moment the framework wires your `State` to its `BuildContext`, before `initState` runs, and stays `true` until `dispose` is called, after which it is `false` forever. Under the hood it is nothing more than a null check on the element reference: `bool get mounted => _element != null;`. That is the whole mechanism. When the element that backs your widget is torn out of the tree, `_element` goes null, `mounted` flips to `false`, and any `setState` you attempt from that point is an error the framework actively rejects.

## Why an await is where this breaks

Flutter drives everything from a single UI thread. As long as your event handler runs synchronously, the widget you are looking at cannot disappear mid-method: nothing else gets a turn. The instant you write `await`, that guarantee is gone. Control returns to the event loop, other frames render, gesture callbacks run, route transitions complete. Your continuation is scheduled for some later microtask, and between "before the await" and "after the await" the user could have tapped back, a parent could have rebuilt you away, or a `Navigator.pop` elsewhere could have disposed your route.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _ProfileState extends State<Profile> {
  bool _loading = false;
  User? _user;

  Future<void> _load() async {
    setState(() => _loading = true);      // fine: still on the same frame
    final user = await api.fetchUser();    // control leaves; frames run
    setState(() {                          // may run after dispose()
      _user = user;
      _loading = false;
    });
  }
}
```

Nothing in `_load` looks wrong, and it works every time you test it on a screen you do not leave. Navigate away while `fetchUser` is in flight, though, and the second `setState` lands on a disposed `State`. In debug you get a `FlutterError`: `setState() called after dispose(): _ProfileState#1a2b3(lifecycle state: defunct, not mounted)`. This is the same structural mistake described from the context angle in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), but here the casualty is state mutation rather than an inherited-widget lookup.

## The minimal guard, step by step

Follow these three steps for any async method in a `State` that calls `setState` after it suspends.

1. **Do the async work.** Let the `await` take as long as it needs. You are not holding anything fragile across it yet; `mounted` is a live getter, not a value you cached.
2. **Guard the resume.** Immediately after the `await`, before any `setState`, write `if (!mounted) return;`. If the widget left the tree during the await, you stop here and never touch the disposed `State`.
3. **Call setState only past the guard.** Everything that mutates state and rebuilds the widget goes after the check, on the same synchronous tick, so nothing can dispose you between the guard and the call.

Applied to the broken example:

```dart
// Flutter 3.44, Dart 3.x -- guarded
Future<void> _load() async {
  setState(() => _loading = true);
  final user = await api.fetchUser();   // 1. async work

  if (!mounted) return;                 // 2. guard the resume

  setState(() {                         // 3. safe: State is still mounted
    _user = user;
    _loading = false;
  });
}
```

That is the entire fix for the common case. `mounted` is `false` the moment `dispose` has run, so the guard skips the `setState` exactly when it would have thrown. Note the guard reads `mounted` fresh after the await; a check placed *before* the await tells you nothing, because the gap you care about is the await itself.

## Why checking mounted is the floor, not the ceiling

The Flutter framework is blunt about this in the `setState` error text itself. Its recommended fix is not only to check `mounted`, it is to cancel the work that would call `setState` in the first place. The reasoning: a `mounted` guard prevents the exception, but the async work still ran to completion and burned CPU, network, and battery producing a result you then throw away. If a `Timer` fires every second on a screen the user left ten minutes ago, guarding each tick with `mounted` stops the crash but leaves the timer running forever.

So treat `if (!mounted) return;` as the last line of defence, and cancel the source in `dispose` as the real fix wherever the source is cancellable.

```dart
// Flutter 3.44, Dart 3.x -- cancel the source, then guard as backup
class _ClockState extends State<Clock> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;             // backstop
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();                   // the real fix: stop the source
    super.dispose();
  }
}
```

With the `cancel()` in `dispose`, the callback stops firing the moment the widget leaves, so the `mounted` guard almost never trips. Keeping the guard anyway costs nothing and covers the narrow race where a tick is already queued when `dispose` runs. This is the same discipline you apply when you [dispose controllers to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): own the lifecycle of anything that can call back into your widget.

## Stream subscriptions are the classic offender

A `StreamSubscription` whose `onData` calls `setState` will keep delivering events after the widget is gone unless you cancel it. Store the subscription and cancel it in `dispose`.

```dart
// Flutter 3.44, Dart 3.x
class _FeedState extends State<Feed> {
  StreamSubscription<Item>? _sub;
  final _items = <Item>[];

  @override
  void initState() {
    super.initState();
    _sub = repository.itemStream.listen((item) {
      if (!mounted) return;
      setState(() => _items.add(item));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
```

Forgetting the `cancel()` here is one of the most common ways to see `setState() called after dispose()` in production logs: the stream outlives the widget, and every event that arrives after disposal is a crash the `mounted` guard is quietly absorbing. Cancel the subscription and the events stop at the source. Cancelling every listener you open in `dispose` is worth making as automatic as the [controller disposal that prevents leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## mounted on State vs mounted on BuildContext

There are two `mounted` getters, and picking the right one matters. `State.mounted` is the one this whole guide is about: it lives on your state class, tracks the lifecycle of the widget you own, and is what you check before `setState`. It has existed since the earliest Flutter versions.

`BuildContext.mounted` arrived in Flutter 3.7 for code that holds only a context, not a `State`: helper functions, `StatelessWidget` callbacks, extension methods. It answers the same "is this element still in the tree" question, but you reach for it when there is no `State` in scope.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass, before setState:
if (!mounted) return;          // State.mounted

// In a helper that only has a BuildContext:
if (!context.mounted) return;  // BuildContext.mounted
```

Inside a `State`, prefer `mounted` over `context.mounted`. They usually agree, but `State.mounted` reads the lifecycle of the exact object you are about to call `setState` on, which is precisely the thing that can be defunct. Reserve `context.mounted` for the situations covered in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), where the payload is a `Navigator` or `ScaffoldMessenger` lookup rather than a state mutation.

## Multiple awaits mean multiple guards

Every suspension point reopens the window. If a method awaits twice and calls `setState` after each, it needs a guard after each await, not just the first.

```dart
// Flutter 3.44, Dart 3.x
Future<void> _submit() async {
  setState(() => _status = 'validating');
  final valid = await validate(form);
  if (!mounted) return;                 // guard after await #1

  setState(() => _status = valid ? 'saving' : 'invalid');
  if (!valid) return;

  await repository.save(form);
  if (!mounted) return;                 // guard after await #2

  setState(() => _status = 'done');
}
```

A guard covers only the awaits that precede it. Add a new `await` between an existing guard and a `setState`, and you have silently reopened the gap. When a method sprouts more than two of these guards, that is usually a signal the async work belongs in a controller, an `AsyncNotifier`, or a stream your widget renders declaratively, rather than a pile of imperative `setState` calls. Modelling it as [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) hands the lifecycle bookkeeping to the framework and removes most manual guards entirely.

## The lint will not catch this one

It is worth being clear about what tooling does and does not do here. The `use_build_context_synchronously` lint from `flutter_lints` flags a `BuildContext` used after an async gap without a guard. It does **not** flag a bare `setState` after an await, because `setState` does not take a context and the lint is not looking for it. There is no analyzer rule that will underline the unguarded `setState` in the first example of this post. That makes the habit entirely yours to keep: the compiler is silent, the analyzer is silent, and the only signal is a crash in a log after a user navigated away at the wrong moment.

The practical consequence is that you cannot lean on a red squiggle to find these. Audit any `State` method that both `await`s and calls `setState`, and make the guard reflexive the way you already treat `super.dispose()`.

## Gotchas and lookalikes

**This is a different bug from setState during build.** The `setState() called after dispose()` crash and the `setState() or markNeedsBuild() called during build` crash are unrelated despite the similar text. The dispose one is about calling `setState` too late, after the widget is gone; the build one is about calling it too early, synchronously inside a build pass. The fixes are different, and the [setState called during build guard](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) covers the second. If your stack trace says "during build," the `mounted` check is not your fix.

**Release builds still crash, just later.** The `setState() called after dispose()` error is a real thrown `FlutterError`, not a debug-only assertion, so unlike the deactivated-context lookups it does surface in release. But because it fires from an async callback, the stack trace often points at framework code far from your `_load` method, which makes it easy to misattribute. A crash that only appears after navigation, from inside a `Future.then` or a stream handler, is almost always an unguarded post-await `setState`.

**`FutureBuilder` and `StreamBuilder` sidestep the guard.** If you feed the async work to a `FutureBuilder` or `StreamBuilder` instead of calling `setState` by hand, the builder tracks the widget lifecycle for you and never calls `setState` on a dead `State`. Reaching for [FutureBuilder or StreamBuilder over manual setState](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) removes an entire category of these bugs, at the cost of restructuring the async flow around the builder.

**The Riverpod equivalent.** If you hold a `WidgetRef` or a notifier's `Ref` instead of a `State`, the matching crash is a disposed-ref error rather than a disposed-`State` error, and the guard is `ref.mounted` rather than `mounted`. Same root cause, same shape of fix, covered in [checking Ref.mounted after an async gap in Riverpod 3.0](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## The habit that retires the crash

Read a `State` as valid only from the start of a synchronous run until the next `await`. After you resume, check `mounted` before you call `setState`. And wherever the thing that triggers `setState` is a timer, a subscription, or any long-lived source, cancel it in `dispose` so the callback never fires on a widget that is already gone. Do that mechanically and `setState() called after dispose()` stops appearing in your logs, because you removed both the crash and the wasted work behind it.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html), Flutter API docs, on when `mounted` is true and false across the `State` lifecycle.
- [State.setState method](https://api.flutter.dev/flutter/widgets/State/setState.html), Flutter API docs, which spells out the `setState() called after dispose()` error and recommends cancelling the source over merely checking `mounted`.
- [State.dispose method](https://api.flutter.dev/flutter/widgets/State/dispose.html), Flutter API docs, on releasing timers and subscriptions when the widget leaves the tree.
- [use_build_context_synchronously lint rule](https://dart.dev/tools/linter-rules/use_build_context_synchronously), Dart linter rules, for what the analyzer does and does not flag.
