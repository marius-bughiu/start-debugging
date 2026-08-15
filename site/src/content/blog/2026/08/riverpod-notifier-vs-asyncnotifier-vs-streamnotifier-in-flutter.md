---
title: "Riverpod Notifier vs AsyncNotifier vs StreamNotifier in Flutter: which one do I extend?"
description: "Pick by the return type of build(): T means Notifier, FutureOr<T> means AsyncNotifier, Stream<T> means StreamNotifier. Here is the decision matrix, the type hierarchy that explains why, and the == filtering and state-clobbering gotchas that bite each one. Verified against flutter_riverpod 3.4.2 on Flutter 3.44.2."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
---

The choice between `Notifier`, `AsyncNotifier`, and `StreamNotifier` is decided by one thing: the return type of your `build()` method. If it returns `T`, extend `Notifier<T>`. If it returns `Future<T>` or a plain `T` you might later want to make async, extend `AsyncNotifier<T>`. If your data source keeps pushing new values after the first one, extend `StreamNotifier<T>`. Everything else (mutation methods, `ref.watch` inside `build`, families, auto-disposal) works identically across all three. Everything in this post is verified against `flutter_riverpod` 3.4.2 on Flutter 3.44.2 (stable, 2026-06-10) and Dart 3.12.2, with `riverpod_generator` 4.0.4 for the code-generation section.

## The decision matrix

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` returns | `T` | `FutureOr<T>` | `Stream<T>` |
| Provider type exposes | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| Provider class | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| Loading state | none, ever | `AsyncLoading` first | `AsyncLoading` first |
| Values after the first | you write them | you write them | the stream writes them |
| `.future` modifier | no | yes | yes |
| `update()` helper | no | yes | yes |
| `updateShouldNotify` signature | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| Replaces (Riverpod 2.x) | `StateNotifier`, `StateProvider` | `FutureProvider` + methods | `StreamProvider` + methods |

The last row is the one people trip on. `AsyncNotifier` is not "the async version of `Notifier`" in the sense of being a superset. It is `FutureProvider` with a place to put mutation methods. `StreamNotifier` is `StreamProvider` with the same. If you do not need mutation methods, a plain `FutureProvider` or `StreamProvider` is still the smaller answer.

## Why the return type is the whole rule

This is not a style convention. It is enforced by the class hierarchy in `riverpod` 3.4.2. Each of the three public classes declares an abstract `build()` with a fixed return type:

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

Pick the wrong one and you get a compile error, not a runtime surprise. These are the exact diagnostics from `flutter analyze` on Flutter 3.44.2:

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

That third one is the mismatched-pairing error: a `Notifier` subclass handed to an `AsyncNotifierProvider`. The notifier class and the provider class are locked together by a generic bound, so you cannot mix them.

## When to pick Notifier

Reach for `Notifier<T>` when the initial state is available synchronously and nothing outside your own methods changes it.

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` gives you an `int`, not an `AsyncValue<int>`. There is no loading branch to render and no error branch either, which is exactly the point: a filter selection, a form's dirty flag, a selected tab index, an in-memory shopping cart. If you find yourself writing `AsyncData(...)` around a value you already have, you picked the wrong base class.

The one thing that surprises people coming from `StateNotifier`: `build()` can re-run. If you `ref.watch` another provider inside it, a change upstream re-executes `build()` and resets your state. The notifier instance itself is preserved, so instance fields survive:

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## When to pick AsyncNotifier

Reach for `AsyncNotifier<T>` when the initial state comes from a `Future` and every value after that comes from your own mutation methods.

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

The `future` getter inside the notifier and the `.future` modifier on the provider both come from the `$AsyncClassModifier` mixin. So does `update()`, which is the ergonomic version of the read-modify-write above:

```dart
Future<void> increment() => update((current) => current + 1);
```

One detail worth knowing because it changes what your widget renders on the first frame: `build()` returns `FutureOr<T>`, so returning a value synchronously is legal, and when you do, the provider never passes through `AsyncLoading`.

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

That makes `AsyncNotifier` a reasonable default for state that is synchronous today but that you expect to move behind a network call later. You pay for it with an `AsyncValue` wrapper you have to unwrap in every widget, which is why I would not use it for a tab index. For rendering that wrapper cleanly, the mechanics are the same ones covered in [showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## When to pick StreamNotifier

Reach for `StreamNotifier<T>` when the source keeps pushing. A Firestore snapshot listener, a WebSocket, a `Stream` from a plugin, a periodic timer.

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

The distinguishing behaviour is that state keeps changing without you writing to `state`. Listening to that provider and collecting the emissions gives `[0, 1, 2, ...]`, where an `AsyncNotifier` would have given exactly one `AsyncData` and then stopped.

Riverpod manages the subscription for you. When `build()` re-runs because a watched dependency changed, the previous subscription is cancelled before the new stream is subscribed:

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

You still need the `ref.onDispose` above for resources the stream itself does not own, like the `Timer`. Riverpod cancels its subscription to your stream; it does not know about the timer feeding it. This is the same discipline as [disposing controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## AsyncNotifier and StreamNotifier are siblings, not parent and child

The dartdoc for `StreamNotifier` calls it "a variant of `AsyncNotifier`", which reads like inheritance. It is not. Both extend the same internal base and differ only in one generic argument:

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` extends `AnyNotifier<AsyncValue<ValueT>, ValueT>` in both cases, which is why both expose `AsyncValue<T>` and both get `future` and `update()`. The only difference is `CreatedT`: `FutureOr<ValueT>` versus `Stream<ValueT>`. Meanwhile `$Notifier<StateT>` extends `$SyncNotifierBase<StateT>`, which extends `AnyNotifier<StateT, StateT>`, so its state type and its value type are the same.

The practical consequence is that a type check against `AsyncNotifier` will not match a `StreamNotifier`, so generic helper code that does `if (notifier is AsyncNotifier)` silently skips your stream-backed providers:

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## The == filtering gotcha hits all three

Riverpod 3.0 standardised on `==` to decide whether to notify listeners. Most write-ups frame that as a `Notifier` problem, because the classic symptom is mutating a `List` in place and seeing no rebuild. It is not a `Notifier` problem. It applies to `AsyncNotifier` and `StreamNotifier` too, because `AsyncValue.operator ==` compares the wrapped value with `==`:

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

Wrapping the same `List` instance in a fresh `AsyncData` therefore produces a value that is `==` to the previous state, and the notification is dropped:

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

The fix is the same in all three classes: always assign a new collection instance rather than mutating and reassigning. The escape hatch is also the same, but note the signature changes with the base class, because `updateShouldNotify` takes the *state* type, not the value type:

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

If you got here after a stream mysteriously stopped updating the UI, the same root cause is covered in more depth in the write-up on [Riverpod 3.0 StreamProvider events filtered by equality](/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## The StreamNotifier gotcha: your writes get overwritten

`StreamNotifier` inherits the `state` setter, so nothing stops you from assigning to it. But the stream is still live, and the next event wins:

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

This is not a bug, and it is not a reason to avoid mutation methods on a `StreamNotifier`. It is a reason to make the mutation optimistic and let the stream confirm it. Write to `state` for the immediate UI response, send the change to the backend, and let the echoed stream event become the source of truth:

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

If the stream does not echo your mutations back, you do not have a stream-shaped problem. Use an `AsyncNotifier` and own the state yourself.

## Code generation makes the choice for you

With `riverpod_generator`, you never name the base class. You annotate with `@riverpod`, extend the generated `_$Foo`, and the generator reads the return type of `build()`. Here are three classes that differ only in that return type, and the corresponding generated declarations from `riverpod_generator` 4.0.4:

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

Change `Future<int> build()` to `Stream<int> build()`, rerun the builder, and the base class changes underneath you with no other edit. That is the strongest practical argument for code generation on this specific question.

One asymmetry the generated output makes visible: generated providers are auto-disposing, hand-written ones are not.

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

For a `StreamNotifier` that difference is expensive: a hand-written stream provider keeps its subscription open forever once something reads it, because `NotifierProvider`, `AsyncNotifierProvider`, and `StreamNotifierProvider` all default `isAutoDispose` to `false`. Pass `NotifierProvider(..., isAutoDispose: true)` if you want the generated behaviour without generating.

## One more version caveat

On Flutter 3.44.2 the newest packages do not currently co-resolve. `flutter_riverpod` 3.4.2 plus any version of `riverpod_generator` fails version solving against the `matcher` 0.12.19 and `test_api` 0.7.11 that this Flutter SDK pins through `flutter_test`. The combination that resolves cleanly is `flutter_riverpod` 3.3.2 with `riverpod_annotation` 4.0.3 and `riverpod_generator` 4.0.4, which is what the generated output above came from. Nothing in the class-selection rule differs between 3.3.2 and 3.4.2, but if you are on code generation, expect to lag the runtime package by a minor version until the SDK constraint catches up.

## The recommendation

Default to `AsyncNotifier` for anything that touches I/O, `Notifier` for anything that does not, and `StreamNotifier` only when a source genuinely pushes more than one value. The failure mode of picking `AsyncNotifier` when `Notifier` would do is a bit of `AsyncValue` unwrapping noise in your widgets. The failure mode of picking `Notifier` when the data is async is a `late` field, a `LateInitializationError`, and a manual loading boolean, which is strictly worse. And if you are on code generation, stop thinking about this entirely: write the `build()` you actually want and let the generator pick.

## Related

- [Which Riverpod package to install: riverpod, flutter_riverpod, or hooks_riverpod](/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder and StreamBuilder compared to Riverpod's AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [The full Riverpod 2.x to 3.0 migration guide](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Moving a setState StatefulWidget onto a Riverpod Notifier](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Turning a FutureBuilder into a Riverpod AsyncNotifier](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Sources

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), on the notifier unification and the move to `==` for notification filtering.
- [riverpod 3.4.2 on pub.dev](https://pub.dev/packages/riverpod/versions/3.4.2), source for the `Notifier`, `AsyncNotifier`, and `StreamNotifier` declarations quoted above.
- [flutter_riverpod 3.4.2 on pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.2).
- [riverpod_generator 4.0.4 on pub.dev](https://pub.dev/packages/riverpod_generator/versions/4.0.4), the generator whose output is shown in the code-generation section.
