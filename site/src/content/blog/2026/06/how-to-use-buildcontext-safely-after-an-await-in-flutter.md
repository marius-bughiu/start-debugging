---
title: "How to use BuildContext safely after an await in Flutter"
description: "Capture what you need from the context before the await, then guard the resume with if (context.mounted) return. Here is the full pattern, the lint that enforces it, and the edge cases it misses."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
---

The rule is short: a `BuildContext` is only valid while its widget is mounted, and an `await` can unmount the widget before your code resumes. So capture everything you need from the context (a `NavigatorState`, a `ScaffoldMessengerState`, a theme value) before the first `await`, do the async work, then guard the resume with `if (!context.mounted) return;` before touching the context again. That single habit prevents the whole family of "used a context after it left the tree" crashes. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

A `BuildContext` is not a bag of data you can stash and reuse. It is a live handle to an `Element` in the widget tree. The moment the user navigates away, the parent rebuilds you out of existence, or the route pops, that element is deactivated and then disposed. Reading an ancestor from a dead element (`Navigator.of`, `Theme.of`, `Provider.of`) is undefined: in debug you get an assertion, in release you get a stale value or a null dereference much later. The async case is the one that bites hardest because the gap between "context was valid" and "context is used" is invisible in the source: it hides inside the `await`.

## Why an await is the dangerous part

Flutter calls `build` synchronously and expects it to finish before anything else touches the tree. As long as your code runs synchronously from an event handler, the context stays valid the whole time. The instant you `await`, you hand control back to the event loop. Other frames run. The user can tap the back button, a parent `StreamBuilder` can rebuild, a timeout can fire a route pop. When your continuation resumes, you are on a later frame, and the widget that owned `context` may be gone.

```dart
// Flutter 3.44, Dart 3.x -- the gap is invisible but real
Future<void> _onSave() async {
  await api.save(form);            // <-- control leaves here, frames run
  Navigator.of(context).pop();     // <-- may execute on a dead context
}
```

Nothing in `_onSave` looks wrong. The bug is structural: `context` was captured implicitly at the call site and reused across a suspension point. This is exactly the situation the [deactivated widget's ancestor crash](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) describes from the error-message side. Here we are looking at it from the prevention side.

## The safe pattern, step by step

Follow these four steps any time an async method needs a context after it suspends. The first two are the load-bearing ones; the rest are how you keep them honest.

1. **Read everything off the context before the first `await`.** Resolve `Navigator.of(context)`, `ScaffoldMessenger.of(context)`, `Theme.of(context)`, and any `Provider.of`/`context.read` calls into local variables while the widget is still mounted. These return long-lived state objects that stay valid even after the originating element dies.
2. **Do the async work.** Now the `await` can take as long as it wants. You are not holding the context across it; you are holding the resolved state objects, which outlive the element.
3. **Guard the resume with a mounted check.** Immediately after the `await`, write `if (!context.mounted) return;` (or `if (!mounted) return;` inside a `State`). If the widget left the tree during the await, you stop here and never touch a dead context.
4. **Use only the captured objects after the gap.** Call `navigator.pop()` and `messenger.showSnackBar(...)` on the locals you grabbed in step 1, not on `Navigator.of(context)` again.

Applied to the broken example:

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _onSave() async {
  final navigator = Navigator.of(context);          // 1. capture
  final messenger = ScaffoldMessenger.of(context);

  await api.save(form);                              // 2. async work

  if (!context.mounted) return;                      // 3. guard

  messenger.showSnackBar(                            // 4. use captures
    const SnackBar(content: Text('Saved')),
  );
  navigator.pop();
}
```

Two independent things make this correct. Capturing `navigator` and `messenger` before the await means you never call `.of(context)` on a deactivated element. The `context.mounted` check then skips the UI work entirely when the user already left, which is almost always the behaviour you want anyway: there is no point showing a snackbar on a screen nobody is looking at.

## mounted on State vs mounted on BuildContext

There are two `mounted` getters and they are not interchangeable in where you reach for them, though they answer the same question.

`State.mounted` has existed forever. Inside a `StatefulWidget`'s state class, write `if (!mounted) return;`. It is `true` between `initState` and `dispose`, and crucially it is already `false` during `deactivate`, so it correctly catches the "widget is leaving" case, not just the "widget is fully dead" case.

`BuildContext.mounted` arrived in Flutter 3.7 (Dart 2.19) for the case where you only have a context, not a `State`: helper functions, callbacks in a `StatelessWidget`, extension methods. It returns whether the underlying element is still mounted.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass:
if (!mounted) return;          // State.mounted

// In a helper that only has a context:
if (!context.mounted) return;  // BuildContext.mounted
```

Prefer `State.mounted` when you are inside a state class, because it reads the lifecycle of the widget you actually own. Use `context.mounted` when a context is all you have. Both must be checked *after* the await, never before: the gap is the await, so a check that runs before it tells you nothing about the state after it.

## Why capturing alone is not enough, and guarding alone is not enough

People often do one of the two halves and assume they are covered. They are not.

If you only **capture** but skip the guard, you avoid the deactivated-context crash, but you can still run UI side effects against a screen the user already left: a snackbar that flashes on the wrong route, a `pop()` that pops a route that is not yours anymore. Capturing makes the call legal; the guard makes it *correct*.

If you only **guard** but skip the capture, you have a subtle ordering bug. Consider:

```dart
// Flutter 3.44, Dart 3.x -- still wrong despite the guard
Future<void> _onSave() async {
  await api.save(form);
  if (!context.mounted) return;
  Navigator.of(context).pop();   // re-reads context AFTER the gap
}
```

This usually works, because the `context.mounted` check passed on the same synchronous tick as the `Navigator.of` call. But it is fragile: if you add a second `await` between the check and the lookup, the window reopens. The capture-first pattern removes the lookup from the post-await path entirely, so there is nothing left to go stale. Treat "capture before, guard after, use captures" as one indivisible move.

## The lint that enforces this: use_build_context_synchronously

Dart ships a linter rule, `use_build_context_synchronously`, that flags a `BuildContext` used after an async gap without a `mounted` guard between the await and the use. It is enabled by default in the `flutter_lints` package, which new Flutter projects include via `analysis_options.yaml`:

```yaml
# analysis_options.yaml -- on by default in flutter_lints
include: package:flutter_lints/flutter.yaml
```

If your project predates the default or you stripped the include, add the rule explicitly:

```yaml
# analysis_options.yaml
linter:
  rules:
    use_build_context_synchronously: true
```

The rule understands the guard. Writing `if (!context.mounted) return;` (or `if (context.mounted) { ... }`) after the await clears the warning, because the analyzer can prove the context is live on the path that uses it. This is why the canonical form is `if (context.mounted)` and not some equivalent you wrote by hand: the lint pattern-matches the known-safe shapes. Earlier versions of the analyzer even produced a false positive when `BuildContext.mounted` was used outside the literal `if (context.mounted) {}` shape, tracked in the Dart SDK issue list; current versions handle the common forms, but it is one more reason to stick to the idiomatic guard.

What the lint does **not** catch is just as important. It is a syntactic check, so it cannot see across function boundaries. If you pass a `BuildContext` into a helper and `await` inside that helper, the analyzer often cannot connect the gap to the later use. It also will not save you from logic that captures a context into a field and reuses it much later. The lint is a strong first line of defence, not a proof.

## Passing a context into a helper function

A frequent escape from the lint is moving the await into a helper that takes `BuildContext` as a parameter. The pattern is fine, but the helper now owns the responsibility for the guard, and it should re-check `mounted` itself rather than trusting the caller.

```dart
// Flutter 3.44, Dart 3.x -- the helper guards its own context use
Future<void> confirmAndDelete(BuildContext context, Item item) async {
  final messenger = ScaffoldMessenger.of(context);

  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const ConfirmDialog(),
  );

  if (ok != true) return;
  if (!context.mounted) return;   // guard inside the helper

  await repository.delete(item);
  if (!context.mounted) return;   // second await, second guard

  messenger.showSnackBar(const SnackBar(content: Text('Deleted')));
}
```

Two awaits means two guards. Every suspension point reopens the window, so a `mounted` check belongs after each one that precedes a context use, not just the first. Capturing `messenger` up front means the final line never re-reads the context at all.

## Loops, retries, and multiple awaits

Anywhere a context use sits after more than one possible suspension, audit each path. A retry loop is the textbook case:

```dart
// Flutter 3.44, Dart 3.x
Future<void> _uploadWithRetry() async {
  final messenger = ScaffoldMessenger.of(context);

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.upload(file);     // suspension point inside the loop
      break;
    } catch (_) {
      if (attempt == 3) rethrow;
      await Future<void>.delayed(const Duration(seconds: 1)); // another one
    }
  }

  if (!context.mounted) return;   // single guard after the loop is enough
  messenger.showSnackBar(const SnackBar(content: Text('Uploaded')));
}
```

You do not need a guard inside the loop here because nothing inside the loop touches the context; the only context use is after it, so one guard covers all exit paths. The principle generalizes: place the guard immediately before each context use, after the last await that can precede it. Reaching for a structured approach like [graceful error and loading handling](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) keeps these flows readable, because the retry and error states become data your widget renders rather than imperative UI calls scattered after awaits.

## StatelessWidget has no mounted, so use the context

A `StatelessWidget` has no `State`, so there is no `mounted` field. Use `context.mounted`, which is exactly what it exists for:

```dart
// Flutter 3.44, Dart 3.x -- StatelessWidget callback
ElevatedButton(
  onPressed: () async {
    final navigator = Navigator.of(context);
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    navigator.pop();
  },
  child: const Text('Close'),
);
```

If you find yourself needing several guards in a stateless widget's callbacks, that is often a signal the widget should be stateful, or that the async work belongs in a controller or notifier rather than inline in the button handler.

## Gotchas and lookalikes

**`Navigator.pop` then a context use.** A classic two-liner: `Navigator.pop(context)` followed by another `.of(context)` call. The pop starts deactivating the route's element, so the second lookup can throw even with no await in sight. Capture the navigator (and anything else) before popping.

**`initState` cannot do inherited lookups.** `Theme.of`, `MediaQuery.of`, and any `dependOnInheritedWidgetOfExactType` are illegal in `initState` because the element is not yet wired to its inherited dependencies. Move those reads to `didChangeDependencies`, where the context is fully valid. That is a different assertion from the async one, but it stems from the same "is the context valid right now" question.

**Release builds hide the crash.** The deactivated-context assertion only fires in debug. In profile and release the lookup returns null and you get a `Null check operator used on a null value` somewhere downstream. If a crash appears only in release and only after navigation, suspect an unguarded post-await context use. The [setState called during build guard](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) has the same debug-only-assert character.

**The Riverpod equivalent.** If you hold a `WidgetRef` instead of a `BuildContext`, the matching crash is [Cannot use "ref" after the widget was disposed](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Same root cause, same fix: read before the await, guard after. Modelling async work as [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) sidesteps most manual guards, because the framework tracks the widget lifecycle for you and you stop poking the context by hand.

**Timers and stream listeners.** A context used in a `Timer`, a `Stream.listen`, or an animation status listener can fire after the widget is gone. Guard with `mounted`, and also cancel the source in `dispose` so the callback stops firing at all, the same discipline you apply when you [dispose controllers to avoid leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## The one habit that retires the whole bug class

Treat a `BuildContext` as valid only from the start of a synchronous run until the next `await`. Before you suspend, read out the state objects you will need. After you resume, check `mounted` before you touch anything tied to the tree. Do that mechanically and the deactivated-ancestor crash, the disposed-controller crash, and the post-await null dereference all stop appearing, because they were never three bugs. They were one rule, broken three ways.

## Sources

- [use_build_context_synchronously lint rule](https://dart.dev/tools/linter-rules/use_build_context_synchronously), Dart linter rules, which defines what the analyzer flags and the guard shapes it recognizes.
- [BuildContext.mounted property](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html), Flutter API docs (added in Flutter 3.7).
- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html), Flutter API docs.
- [flutter/flutter#19462](https://github.com/flutter/flutter/issues/19462), the canonical issue tracing the deactivated-context crash to async callbacks.
