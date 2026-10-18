---
title: "How to Replay the Latest Value to Late Subscribers of a Dart Stream Without rxdart's BehaviorSubject"
description: "A broadcast StreamController drops every event that fired before you subscribed. Here is a dependency-free BehaviorSubject replacement built on Stream.multi, a replayLatest() extension for existing streams, the async* shortcut that silently loses events, and the StreamBuilder initialData detail, all verified on Dart 3.12.2."
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
---

**Short answer:** wrap a `StreamController.broadcast()` in a small class that also stores the last value, and expose the stream through `Stream.multi`. `Stream.multi` calls your `onListen` callback once per subscriber with that subscriber's own `MultiStreamController`, so you can `add` the cached value to the new listener only, then forward the broadcast events. That is the whole behaviour of rxdart's `BehaviorSubject`, in about 40 lines of `dart:async`. `Stream.multi` has been in the SDK since Dart 2.9, and every snippet below was run on Dart 3.12.2 (the SDK that ships with Flutter 3.44).

The rest of this post shows why the plain broadcast controller fails, the full class, an extension that turns any existing stream into a replaying one, and the edge cases that matter in a Flutter app: errors, `close()`, pause, cancellation, and the first frame of a `StreamBuilder`.

## Why a broadcast stream forgets everything

A single-subscription `StreamController` buffers events until someone listens, but it allows exactly one listener. A broadcast controller allows any number of listeners, and the price is that it buffers nothing. An event is delivered to whoever is subscribed at the moment it fires, and then it is gone.

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final controller = StreamController<int>.broadcast();
  controller.add(1);                 // nobody is listening: dropped
  await Future(() {});

  controller.stream.listen((v) => print('late listener got $v'));
  controller.add(2);
  await Future(() {});
}
// Output:
// late listener got 2
```

This is the right default for event-like data (taps, notifications, log lines), and the wrong one for state-like data. If the stream represents "the current user" or "the connection status", a widget that subscribes after the last change shows nothing until the next change, which may never come. In Flutter this usually surfaces as a `StreamBuilder` stuck on its loading branch on a screen you navigated to after the data had already loaded.

rxdart solves it with `BehaviorSubject`, which remembers the latest event and emits it to every new subscriber. If you already depend on rxdart, use it. If you only need this one behaviour, pulling in an entire reactive extensions library for it is overkill, and the SDK already has the primitive you need.

## The primitive: Stream.multi gives each listener its own controller

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` creates a stream that can be listened to any number of times. Every call to `listen` invokes `onListen` with a fresh `MultiStreamController`, and whatever you `add` to that controller goes only to that one subscription.

That per-listener hook is exactly what a broadcast controller lacks. `StreamController.broadcast(onListen: ...)` fires `onListen` only when the listener count goes from zero to one, so the second, third, and hundredth subscriber never get a callback in which you could hand them the cached value.

The `isBroadcast` flag does not change behaviour. It only sets the `Stream.isBroadcast` getter, which some consumers check. Set it to `true` when your stream behaves like a broadcast stream (multiple listeners allowed, no per-listener buffering of the past beyond what you replay), which is the case here.

## Step by step: a dependency-free BehaviorSubject

1. Keep a broadcast `StreamController` as the event hub.
2. Store the latest value (and whether there is one) next to it.
3. Expose a single `Stream.multi` instance whose `onListen` first adds the cached value to the new subscriber's controller, then forwards hub events to it.
4. Wire pause, resume, and cancel from the per-listener controller to the hub subscription so nothing leaks.

```dart
// Dart 3.12.2 (Stream.multi requires Dart 2.9+)
import 'dart:async';

class ValueStream<T> {
  ValueStream(T initial) : _value = initial, _hasValue = true;
  ValueStream.empty();

  final _hub = StreamController<T>.broadcast();
  late T _value;
  bool _hasValue = false;
  Object? _error;
  StackTrace? _stackTrace;

  /// Synchronous access, like BehaviorSubject.value.
  T get value => _value;
  bool get hasValue => _hasValue;

  void add(T value) {
    _value = value;
    _hasValue = true;
    _error = null;
    _hub.add(value);
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _error = error;
    _stackTrace = stackTrace;
    _hub.addError(error, stackTrace);
  }

  Future<void> close() => _hub.close();

  late final Stream<T> stream = Stream.multi((controller) {
    // 1. Replay the latest event to this listener only.
    if (_error != null) {
      controller.addError(_error!, _stackTrace);
    } else if (_hasValue) {
      controller.add(_value);
    }

    // 2. Already closed: replay, then finish.
    if (_hub.isClosed) {
      controller.close();
      return;
    }

    // 3. Forward future events.
    final sub = _hub.stream.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    controller
      ..onPause = sub.pause
      ..onResume = sub.resume
      ..onCancel = sub.cancel;
  }, isBroadcast: true);
}
```

Using it looks like this:

```dart
// Dart 3.12.2
Future<void> main() async {
  final status = ValueStream<int>(0);
  status.add(1);

  status.stream.listen((v) => print('A got $v'));
  await Future(() {});
  status.add(2);
  await Future(() {});

  status.stream.listen((v) => print('B got $v'));   // subscribes late
  await Future(() {});
  status.add(3);
  await Future(() {});
}
// Output:
// A got 1
// A got 2
// B got 2
// A got 3
// B got 3
```

`B` subscribed after `2` was emitted and still received it, followed by every later event. `A` did not get a duplicate `2` when `B` joined, because the replay went to `B`'s own controller.

A few deliberate choices in that class:

- **`stream` is a `late final` field, not a getter.** One `Stream.multi` instance can be listened to many times, so there is no reason to allocate a new one per access. It also keeps `identical(store.stream, store.stream)` true, which matters for `StreamBuilder` (more below).
- **The replay uses `add`, not `addSync`.** `MultiStreamController` has `addSync`, `addErrorSync`, and `closeSync`, which deliver immediately. The API docs say to use them only when the listener is ready to receive events, typically from inside another asynchronous callback. Calling them inside `onListen` would deliver an event before `listen()` has even returned the subscription, which breaks the Dart convention that streams never emit synchronously during `listen`. Plain `add` queues the event and preserves order: in my test, a `listen` followed immediately by two synchronous `add` calls produced `100, 101, 102`, in that order.
- **Errors are replayed too.** If the last thing that happened was an error, a late subscriber sees the error rather than a stale value. Drop the `_error` branch if you would rather replay the last good value. `BehaviorSubject` replays the latest event, error included, so this matches it.

## Turning an existing stream into a replaying one

Often you do not own the controller. You get a `Stream<T>` from a plugin, a Firestore snapshot, or a `Socket`, and you want several widgets to share it with the latest value replayed. The SDK docs for `Stream.multi` include a `repeatLatest()` example along these lines. Here is a version that also handles errors, completion, and lazy connection:

```dart
// Dart 3.12.2
import 'dart:async';

extension ReplayLatest<T> on Stream<T> {
  Stream<T> replayLatest() {
    final hub = StreamController<T>.broadcast();
    StreamSubscription<T>? source;
    var hasLatest = false;
    late T latest;
    var done = false;

    void connect() {
      source ??= listen(
        (value) {
          hasLatest = true;
          latest = value;
          hub.add(value);
        },
        onError: hub.addError,
        onDone: () {
          done = true;
          hub.close();
        },
      );
    }

    return Stream.multi((controller) {
      connect();                       // subscribe to the source on first listen
      if (hasLatest) controller.add(latest);
      if (done) {
        controller.close();
        return;
      }
      final sub = hub.stream.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = sub.cancel;
    }, isBroadcast: true);
  }
}
```

It works on single-subscription sources, which is the point: the extension listens to the source exactly once and fans the events out.

```dart
// Dart 3.12.2
Future<void> main() async {
  final source = StreamController<int>();          // single-subscription
  final shared = source.stream.replayLatest();

  shared.listen((v) => print('first: $v'));
  source.add(1);
  source.add(2);
  await Future(() {});

  shared.listen((v) => print('late: $v'), onDone: () => print('late: done'));
  await Future(() {});
  source.add(3);
  await source.close();
  await Future(() {});

  shared.listen((v) => print('after close: $v'),
      onDone: () => print('after close: done'));
  await Future(() {});
}
// Output:
// first: 1
// first: 2
// late: 2
// first: 3
// late: 3
// late: done
// after close: 3
// after close: done
```

Note what this extension deliberately does not do: it never cancels the source subscription, even when every listener has gone. That differs from rxdart's `shareValue()`, which is reference counted and cancels the source when the last listener leaves; this extension behaves like `publishValue()` connected once and kept alive, which is what you want for app-lifetime state. If the source is expensive (a GPS stream, a WebSocket), add reference counting: track the number of active per-listener controllers in `onListen` and `onCancel`, and cancel `source` when it drops to zero. Decide up front whether a late subscriber after that point should still get the old cached value or wait for a reconnect.

## The async* shortcut that loses events

The first thing most people try is a generator:

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

It reads perfectly, and it is wrong. An `async*` function suspends at `yield` until the event has been delivered, and only then continues to the `yield*` line, which is the moment it subscribes to the broadcast `updates`. Anything emitted between the listen call and that subscription falls into the gap. I reproduced it with an event scheduled one microtask after `listen`:

```dart
// Dart 3.12.2
Future<void> main() async {
  final updates = StreamController<int>.broadcast();
  var current = 20;

  withLatest(() => current, updates.stream)
      .listen((v) => print('got $v'));

  scheduleMicrotask(() {
    current = 21;
    updates.add(21);
  });
  await Future(() {});
  await Future(() {});
}
// Output:
// got 20
```

The `21` is never printed. The subscriber is now stuck showing `20` while the real state is `21`, and no later event will correct it until something else changes. The `Stream.multi` version does not have this gap because it subscribes to the hub synchronously inside `onListen`, before any queued event can fire.

## Gotchas in a Flutter app

**`StreamBuilder` still shows one frame of "waiting".** The replay is asynchronous (that is the `add` versus `addSync` choice above), and `StreamBuilder` builds its first frame right after subscribing in `initState`. Without help, that first frame has `ConnectionState.waiting` and no data, which renders as a one-frame flash of your loading indicator. Since `ValueStream` exposes the current value synchronously, pass it as `initialData`:

```dart
// Flutter 3.44, Dart 3.12.2
StreamBuilder<int>(
  stream: status.stream,
  initialData: status.hasValue ? status.value : null,
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const CircularProgressIndicator();
    return Text('Status: ${snapshot.data}');
  },
)
```

**Do not build the stream inside `build`.** `StreamBuilder` resubscribes when it receives a stream that is not the same object as last time. A getter that returns `Stream.multi(...)` or `source.replayLatest()` on every access creates a new stream per rebuild, so every rebuild cancels and resubscribes, and with `replayLatest()` it also opens a new subscription to the source. Create the stream once, in a field, a service, or `initState`. The same rule applies to futures, as covered in [how to initialize a Future so FutureBuilder does not recreate it](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

**Cancelling is wired, but you still have to cancel.** Because `onCancel` is forwarded to the hub subscription, a cancelled listener is removed from the broadcast controller. In my test `_hub.hasListener` went from `true` to `false` after `cancel()`. Listeners you call `listen` on manually still need a `StreamSubscription` field and a `cancel()` in `dispose`, exactly as in [cancelling a StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). `StreamBuilder` does that for you.

**Close the hub when the owner goes away.** A `ValueStream` owned by a widget's `State` should be closed in `dispose()`, next to your other controllers, as described in [disposing controllers to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/). Listening after `close()` is safe: the subscriber gets the final value and then a done event.

**Unhandled replayed errors are still unhandled.** If you replay an error to a listener that has no `onError`, it becomes an uncaught async error and goes to the zone's error handler, in Flutter `PlatformDispatcher.instance.onError`. See [catching uncaught async errors in Flutter](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/) for where that lands.

**Equality filtering is a separate decision.** `BehaviorSubject` does not deduplicate, and neither does this class. If you want "only emit when the value changes", add an `if (value == _value) return;` guard in `add`, and be aware of the trade-offs with mutable objects that make the same mistake [Riverpod's StreamProvider equality filter](/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/) does.

## When you do not need a stream at all

If the value only feeds widgets and never crosses an async boundary, a `ValueNotifier<T>` with `ValueListenableBuilder` is simpler than any stream: it has a synchronous `value`, notifies listeners when it changes, and the builder reads the current value on its first frame, so there is no loading flash. Reach for the replaying stream when you need stream operators (`where`, `asyncMap`, `debounce`-style transforms), when the data comes from an existing `Stream` API, or when a state management library such as Riverpod's `StreamProvider` expects a stream. For a broader comparison of those options, see [FutureBuilder and StreamBuilder vs Riverpod's AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

And when you need more than the latest value, such as "replay the last 10 events" or "replay everything", the same `Stream.multi` structure works with a bounded `Queue<T>` instead of a single field. At that point you are reimplementing rxdart's `ReplaySubject`, and adding the package is a reasonable trade.

## Sources

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
