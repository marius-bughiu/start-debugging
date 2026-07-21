---
title: "Fix: Riverpod 3.0 StreamProvider stops emitting because updates are filtered by =="
description: "In Riverpod 3.0 every provider filters listener notifications with ==, not identity. A StreamProvider that re-emits the same mutable object stops rebuilding the UI after the first frame. Here is why it happens and three ways to fix it. Tested on flutter_riverpod 3.3.2, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-21
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "streams"
---

If you upgraded to Riverpod 3.0 and a `StreamProvider` suddenly rebuilds your widget exactly once and then goes quiet, the cause is a single line in the migration notes that is easy to skip: in 3.0 every provider filters listener notifications with `==` instead of identity. When your stream emits the same object instance twice (a mutable list you mutate in place, a controller-backed model you push again), Riverpod compares the new value to the previous one, finds them equal, and drops the notification. The stream is still firing. Your `StreamSubscription` outside Riverpod would still see every event. But `ref.watch` never rebuilds, because as far as Riverpod is concerned nothing changed. The fix is to emit a new, non-equal value each time, or to override `updateShouldNotify`. This post is tested on `flutter_riverpod` 3.3.2 (June 2026), Flutter 3.44, and Dart 3.x.

## What actually changed in 3.0

Before 3.0, Riverpod was inconsistent about how it decided whether a new value warranted notifying listeners. Some provider types compared with `==`, some used `identical`, and a few had bespoke logic. `StreamProvider` sat on the identity side of that line: any event the stream produced was pushed to listeners, because a freshly delivered stream event was, in practice, treated as new.

Riverpod 3.0 collapsed all of that into one rule. From the [official 3.0 migration guide](https://riverpod.dev/docs/3.0_migration): "all providers now use `==` to filter updates." The guide names the providers most likely to be affected: "The most likely way for you to be impacted by this change is when using `StreamProvider`/`StreamNotifier`, as stream values will now be filtered by `==`."

That is a good change for consistency. It means a provider that recomputes a value equal to its last one will not needlessly rebuild every widget downstream, which is the same optimization you would otherwise reach for with `select`. The problem is the silent failure mode it introduces for a pattern that was completely fine in 2.x: emitting a mutable object, mutating it, and emitting it again.

## The minimal reproduction

Here is the smallest thing that breaks. A repository holds a `List<int>`, appends to it, and pushes the same list through a `StreamController` after each append.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
import 'dart:async';

class CounterRepository {
  final _values = <int>[];
  final _controller = StreamController<List<int>>.broadcast();

  Stream<List<int>> get stream => _controller.stream;

  void add(int value) {
    _values.add(value);
    _controller.add(_values); // same List instance every time
  }
}
```

Wire it to a `StreamProvider` and watch it:

```dart
// flutter_riverpod 3.3.2
final repositoryProvider = Provider((ref) => CounterRepository());

final valuesProvider = StreamProvider<List<int>>((ref) {
  return ref.watch(repositoryProvider).stream;
});

class ValuesView extends ConsumerWidget {
  const ValuesView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(valuesProvider);
    return async.when(
      data: (values) => Text('Count: ${values.length}'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

On 2.x this shows `Count: 1`, then `Count: 2`, then `Count: 3` as you call `add`. On 3.0 it shows `Count: 1` and then never updates again. The widget is stuck on the first emission.

## Why == returns true here even though the data changed

The trap is that `_values` is the same object across every emission. When you call `_controller.add(_values)` a second time, the stream delivers the identical `List` reference. Riverpod wraps each stream event in an `AsyncData<List<int>>` and asks whether the new `AsyncValue` is equal to the previous one.

`AsyncValue` implements value equality, and two `AsyncData` instances are equal when their contained values are equal. For your list, `==` falls through to `List`'s default equality, which for a plain `List` is reference equality: a list equals only itself. Because it is literally the same object, `previous == next` is `true`. Riverpod concludes the value did not change and suppresses the notification. The mutation you performed between emissions is invisible to the comparison because there is no "previous snapshot" to compare against. There is only one list, and it always equals itself.

This is the part the migration guide understates. A [GitHub issue on exactly this behavior](https://github.com/rrousselGit/riverpod/issues/4310) describes it as a silent failure that cost three days of debugging: direct `stream.listen` callbacks still receive every event, so the stream looks healthy in isolation, but the provider layer quietly deduplicates. The mismatch between "the stream fires" and "the UI does not rebuild" is what makes it so hard to spot.

## Fix 1: emit a new instance every time

The most direct fix, and the one you almost always want, is to stop reusing the same mutable object. Emit an immutable snapshot so each event is a distinct value that is not `==` to the last one.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
void add(int value) {
  _values.add(value);
  _controller.add(List<int>.unmodifiable(_values)); // fresh instance each emit
}
```

`List<int>.unmodifiable(_values)` allocates a new list containing the current elements. It is a different object from the previous emission, so `previous == next` is `false` and Riverpod notifies. As a bonus you are no longer leaking a mutable list into your widget tree, which was a latent bug regardless of Riverpod version: any consumer could have mutated your repository's internal state through the reference it received.

This is not a Riverpod-specific rule. Pushing the same mutable collection through a stream and mutating it in place is fragile with any consumer that snapshots or compares values. Immutable emissions are the durable fix.

## Fix 2: use value equality deliberately, then it just works

Sometimes you *want* `==` to compare contents, because you are emitting a model class and you want the UI to skip rebuilds when nothing meaningful changed. In that case, give your emitted type real value equality and the 3.0 behavior becomes an asset rather than a bug.

```dart
// Dart 3.x records give you value equality for free
final positionProvider = StreamProvider<({double lat, double lng})>((ref) {
  return locationStream(); // each event is a new record
});
```

Dart records compare structurally, so two records with the same fields are `==`. That means a GPS stream that emits the same coordinates twice will correctly skip the rebuild, and one that emits a new position will trigger it. The same holds for a class with a generated `==`/`hashCode` from `freezed`, or a hand-written `operator ==`. The rule of thumb: if the value is immutable and has value equality, 3.0 does the right thing automatically. It only misbehaves when you smuggle a mutable object past the equality check by keeping the same reference.

## Fix 3: override updateShouldNotify on a StreamNotifier

If you genuinely cannot change what the stream emits (a third-party source, a legacy repository you do not own), you can override the comparison. This is only available on the class-based API, so you convert the functional `StreamProvider` to a `StreamNotifierProvider` and override `updateShouldNotify`.

```dart
// flutter_riverpod 3.3.2 with riverpod_annotation 3.x
@riverpod
class Values extends _$Values {
  @override
  Stream<List<int>> build() {
    return ref.watch(repositoryProvider).stream;
  }

  @override
  bool updateShouldNotify(
    AsyncValue<List<int>> previous,
    AsyncValue<List<int>> next,
  ) {
    return true; // always notify, restore the 2.x behavior for this provider
  }
}
```

Returning `true` unconditionally restores the pre-3.0 "notify on every emission" behavior for this one provider without changing the global default for the rest of your app. You can also make it smarter, for example comparing lengths or a version counter, if unconditional rebuilds are too aggressive. Note that the raw functional `StreamProvider((ref) => ...)` has no `updateShouldNotify` hook, so this fix requires the class-based form. If you are still deciding between the functional and class-based styles, the [migration from Riverpod 2.x to 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) guide walks through when each is worth it.

## How to confirm this is your bug and not something else

The symptom (a stream-backed widget that updates once and freezes) has a few possible causes, so verify it is the equality filter before you reach for these fixes:

1. Add a `print` inside the stream source, right before `_controller.add(...)`. If it prints on every event but the widget does not rebuild, the events are reaching the stream but being filtered downstream.
2. Attach a temporary raw listener: `ref.watch(repositoryProvider).stream.listen((v) => debugPrint('raw: $v'))`. If the raw listener fires every time but `ref.watch(valuesProvider)` does not rebuild, the provider layer is deduplicating, which confirms the `==` filter.
3. Check whether the emitted object is the same instance. If you are pushing a field, a cached list, or a singleton model, you are almost certainly hitting this.

If instead the stream itself stops firing, that is a different problem: a `StreamSubscription` that was cancelled, a controller that was closed, or a provider that was disposed and recreated. For the disposal side of stream lifecycles, see [cancelling a StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Related gotchas in the same 3.0 release

The equality filter is one of a cluster of 3.0 changes that surface at runtime rather than compile time, which is what makes them expensive to debug. Two others worth knowing before you ship:

- **Errors now come out wrapped.** A provider that throws no longer rethrows your original exception directly. See [Riverpod 3.0 throwing ProviderException instead of the original error](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) for how to unwrap it.
- **Failed providers retry automatically.** A `FutureProvider` or `StreamProvider` that errors will retry with exponential backoff by default, which can mask a bug or hammer a failing endpoint. Turn it off per-provider or globally as described in [disabling Riverpod 3.0's automatic provider retry](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/).

And if the async gaps inside your notifier touch `ref` after an `await`, guard them with the mounted check covered in [checking Ref.mounted after an async gap](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## The one-line rule to remember

Riverpod 3.0 rebuilds when `previous != next`. If your `StreamProvider` reuses a mutable object, `previous` and `next` are the same reference, so they are always equal and it never rebuilds. Emit immutable snapshots (or give your value type real equality) and the framework does the right thing. Reach for `updateShouldNotify` only when you cannot control the emitted value. For a broader look at when a `StreamProvider` and its `AsyncValue` are even the right tool versus the older builder widgets, the comparison of [FutureBuilder and StreamBuilder against Riverpod's AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) is a good next read.

## Sources

- [Migrating from 2.0 to 3.0, Riverpod official docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [rrousselGit/riverpod issue #4310: updateShouldNotify changes are downplayed in the migration guide](https://github.com/rrousselGit/riverpod/issues/4310)
- [StreamProvider class reference, flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/StreamProvider-class.html)
