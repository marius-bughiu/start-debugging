---
title: "Fix: Bad state: Stream has already been listened to in Flutter"
description: "A single-subscription stream accepts exactly one listen() for its whole life. Create the stream once and give it to one listener, or share it with asBroadcastStream or Stream.multi."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
---

`Bad state: Stream has already been listened to.` means something called `listen()` a second time on a single-subscription stream. That stream type accepts exactly one subscription in its entire lifetime, and cancelling the first one does not reset it. In Flutter the second `listen()` almost always comes from a `StreamBuilder`: two builders on the same stream, a builder that was remounted, or a `.map()`/`.where()` written inside `build()`. Fix it by creating each derived stream once (in `initState` or your state object), and when more than one widget really needs the events, share the source with `asBroadcastStream()`, a `StreamController.broadcast()`, or a per-listener `Stream.multi`.

Every repro and fix below was run on Flutter 3.44.8 with Dart 3.12.2: the plain Dart cases with `dart run`, the widget cases as `flutter test` widget tests.

## The error in context

In plain Dart the exception surfaces from the second `listen()`, and the top frame is the controller refusing a second subscriber:

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

In a Flutter app the same `StateError` is caught by the widgets library and reported against whatever was building at the time. The frames you care about are the two `_StreamBuilderBaseState` lines:

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

If the frame under `_subscribe` is `initState`, a new `StreamBuilder` state was created and subscribed to a stream someone else already owns. If it is `didUpdateWidget`, the builder received a *different* stream object on a rebuild and subscribed to it, and that new object sits on top of a source that is already taken. That one line tells you which of the causes below you have.

## Why a stream refuses a second listener

Dart has two kinds of streams. A **single-subscription** stream is a one-shot sequence: it buffers events until someone listens, delivers them to that one listener, and is finished. A **broadcast** stream can have any number of listeners, but it buffers nothing: each event goes to whoever is subscribed at that moment.

`StreamController()`, `async*` generators, `Stream.value`, `Stream.periodic`, `Future.asStream()`, `File.openRead()`, `Process.stdout`, and the body of an `http` `StreamedResponse` are all single-subscription. When you `listen()` a second time, the controller throws, and it throws even if the first subscription was already cancelled. I checked that explicitly:

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final c = StreamController<int>();
  final first = c.stream.listen((_) {});
  await first.cancel();
  c.stream.listen((_) {}); // StateError: Bad state: Stream has already been listened to.
}
```

Two less obvious facts produce most of the confusion:

1. **Operators listen for you.** `map`, `where`, `expand`, `asyncMap`, `transform`, `distinct` and friends return a new stream that subscribes to its source when *it* is listened to. So `c.stream.where(...)` and `c.stream.map(...)` are two different stream objects, but listening to both still means two `listen()` calls on `c.stream`, and the second one throws.
2. **Consuming methods listen too.** `first`, `last`, `length`, `toList()`, `forEach`, `drain`, `await for`, `pipe` and `bytesToString()` on an `http` body are all `listen()` under the hood. Calling `await stream.first` and then `await stream.toList()` on an `async*` stream throws on the second call.

The type does not reliably tell you what you have, either. On Dart 3.12.2, `isBroadcast` is `false` for `Stream.fromIterable`, yet that particular stream can be listened to more than once (each listener gets its own pass over the iterable), while `Stream.value(1)` and `Future.value(1).asStream()` throw on the second `toList()`. Treat every stream you did not create yourself as single-subscription unless its documentation says otherwise.

## Minimal repro: three ways a StreamBuilder trips it

All three of these fail with the error above. The helper is just a `StreamBuilder` that prints the latest value:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget sb(Stream<int> s) => StreamBuilder<int>(
      stream: s,
      builder: (context, snap) =>
          Text('${snap.data}', textDirection: TextDirection.ltr),
    );

void main() {
  // A: two StreamBuilders on one single-subscription stream (throws in initState)
  testWidgets('A', (t) async {
    final c = StreamController<int>();
    await t.pumpWidget(Column(children: [sb(c.stream), sb(c.stream)]));
  });

  // B: .map() inside build, then the parent rebuilds (throws in didUpdateWidget)
  testWidgets('B', (t) async {
    final c = StreamController<int>();
    late StateSetter rebuild;
    await t.pumpWidget(StatefulBuilder(builder: (context, set) {
      rebuild = set;
      return sb(c.stream.map((x) => x * 2));
    }));
    rebuild(() {});
    await t.pump();
  });

  // C: same stream object, but the StreamBuilder is remounted (throws in initState)
  testWidgets('C', (t) async {
    final stream = StreamController<int>().stream;
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: sb(stream)));
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: sb(stream)));
  });
}
```

Case B is the one that bites people most, because the first frame works. `StreamBuilder` only resubscribes when `oldWidget.stream != widget.stream` (that is the `didUpdateWidget` check in `async.dart`), and `c.stream.map(...)` returns a new object on every `build()`. The first build subscribes `map` #1 to the controller. The next rebuild, which can be a theme change, a keyboard opening, or a parent `setState`, creates `map` #2, `StreamBuilder` unsubscribes from #1 and subscribes to #2, and #2 tries to `listen()` on the controller a second time.

Case C is the real-world shape of "it crashes when I come back to this tab" or "it crashes after I pop and push the page again". The stream lives somewhere long-lived (a service, a top-level variable, a parent widget), the screen that hosts the `StreamBuilder` is disposed and recreated, and the new `State` calls `listen()` on a stream that already had its one listener. Anything that changes the element tree's shape around the builder does this: navigation, `IndexedStack` alternatives that rebuild children, conditional widgets, or a `Key` change.

For comparison, passing the *same* stream object across rebuilds, without remounting, is fine. `StreamBuilder` sees an identical stream in `didUpdateWidget` and keeps its existing subscription. That case passed in the same test file.

## The fix, in order of preference

### 1. Create derived streams once, not in build()

If the stream is only used by one widget, cause B is the whole problem, and the fix is to stop creating a new stream per build. Hold it in the `State`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class PriceLabel extends StatefulWidget {
  const PriceLabel({super.key, required this.ticks});
  final Stream<int> ticks;

  @override
  State<PriceLabel> createState() => _PriceLabelState();
}

class _PriceLabelState extends State<PriceLabel> {
  late Stream<String> _formatted;

  @override
  void initState() {
    super.initState();
    _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
  }

  @override
  void didUpdateWidget(PriceLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ticks != widget.ticks) {
      _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<String>(
        stream: _formatted,
        builder: (context, snap) => Text(snap.data ?? '...'),
      );
}
```

The `didUpdateWidget` override matters: if the parent hands you a genuinely new source, you want a new derived stream for it, and only then. This is the same rule as for `FutureBuilder`, and the reasoning in [initializing a Future so FutureBuilder does not recreate it on every rebuild](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) carries over one to one. In my test, caching `c.stream.map(...)` in a `final` and passing that through a parent rebuild rendered `42` after `c.add(21)`, with no error.

The same discipline applies outside widgets. If you need both the first value and the rest, take them from one subscription instead of calling `first` and then `listen`:

```dart
// Dart 3.12.2
Future<void> readAll(Stream<int> source) async {
  var isFirst = true;
  await for (final value in source) {
    if (isFirst) {
      print('first: $value');
      isFirst = false;
    }
    print('value: $value');
  }
}
```

### 2. Make a factory, not a field, when each listener should start fresh

If every consumer is supposed to get its own independent sequence (a query, a file read, a generator), do not store the stream at all. Store a function that creates one, and call it per listener. An `async*` function is already that function:

```dart
// Dart 3.12.2
Stream<int> countdown(int from) async* {
  for (var i = from; i >= 0; i--) {
    yield i;
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

// Two independent subscriptions, no error:
// countdown(3).listen(print);
// countdown(3).listen(print);
```

Calling `countdown(3)` twice ran without error and gave each caller `[3, 2, 1, 0]`. Reusing one `final s = countdown(3)` for two `toList()` calls threw. Most Flutter data APIs work this way already: a repository method like `watchOrders()` that returns a new stream per call is safe to call from each widget that needs it, as long as you call it in `initState` and not in `build()`.

When you want a single object that can be listened to repeatedly but still behaves per-listener, `Stream.multi` gives you exactly that. Its callback runs once per `listen()` with that listener's own controller:

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. Share one source with asBroadcastStream() or a broadcast controller

When several widgets must observe the *same* live source (one socket, one BLE characteristic, one `Process.stdout`), convert it to broadcast once and hand out that converted stream:

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

With `final shared = c.stream.asBroadcastStream()`, two `StreamBuilder`s on `shared` both rendered `5` after `c.add(5)`, and remounting one of them did not throw. If you own the producer, create it as `StreamController<T>.broadcast()` from the start instead.

The call has to happen **once**. `widget.stream.asBroadcastStream()` inside `build()` is case B again: every call creates a new broadcast wrapper that tries to subscribe to the same single-subscription source.

## Gotchas and variants

**Broadcast streams drop events nobody was listening for.** This is the price of fix 3, and it shows up as a blank screen instead of an exception. In my tests, a late listener on `asBroadcastStream()` received only `[3]` while the first listener got `[1, 2, 3]`, and a `StreamBuilder` remounted on a broadcast stream showed `null` until the next event, even though `7` had been emitted earlier. A single-subscription controller, by contrast, buffered `1` that was added before anyone listened. If a widget needs the current value when it appears, either pass `initialData`, or use a replaying stream; [replaying the latest value to late subscribers without rxdart](/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/) builds one on `Stream.multi`.

**`asBroadcastStream()` keeps the source subscription alive.** By default, when the last broadcast listener cancels, the wrapper only pauses, and the source's `onCancel` never runs. My probe printed `sourceCancelled(default)=false`. Passing `onCancel: (sub) => sub.cancel()` does cancel the source, but then the source is spent for good: the next listener on the wrapper received only `done`. For a socket or sensor you want to close when the screen goes away, own the lifecycle explicitly instead of relying on the wrapper.

**Cancelling is not resetting.** Some fixes online suggest cancelling the old subscription before listening again. That avoids leaks, and you should do it (see [cancelling a StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)), but it does not make a single-subscription stream reusable. Only a new stream does.

**Hot reload keeps the broken stream.** Hot reload preserves `State` and top-level variables, so after you fix the code, a stream that was already consumed in the running app is still consumed. Hot restart, or stop and run, before you decide the fix did not work.

**`http` bodies are single-use.** `StreamedResponse.stream` can be read once. Logging middleware that calls `response.stream.bytesToString()` and then returns the same response to the caller makes the caller's read throw this error. Read the body once into bytes, then build a new `http.Response` from them if something downstream needs it again.

**State management libraries mostly handle this for you.** A `Bloc`'s `stream` and Riverpod's `StreamProvider` already expose broadcast or per-listener streams, so the error usually means a raw controller was passed around next to them. If you are moving a screen off raw `StreamBuilder`s, [FutureBuilder and StreamBuilder vs Riverpod's AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) and [Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) cover which provider type owns the stream lifecycle.

**Lookalike: `Bad state: Cannot add new events after calling close`.** Same `StateError` type, opposite side of the stream: the producer called `add` on a closed controller, usually from a timer or callback that outlived `dispose()`. **Lookalike: `Bad state: No element`.** That comes from `first`, `single` or `last` on a stream (or iterable) that completed empty. Neither is fixed by broadcast streams.

## Related

- [How to cancel a StreamSubscription in dispose to avoid a setState-after-dispose crash in Flutter](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [How to replay the latest value to late subscribers of a Dart stream without rxdart](/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [How to initialize a Future so FutureBuilder does not recreate it on every rebuild](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [FutureBuilder and StreamBuilder vs Riverpod AsyncValue in Flutter](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## Sources

- [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams) on dart.dev, the single-subscription vs broadcast section.
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams), which covers `async*`, `StreamController` and when to use each.
- [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) and [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html) API reference.
- [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) API reference, and the `_StreamBuilderBaseState.didUpdateWidget` implementation in `packages/flutter/lib/src/widgets/async.dart` of Flutter 3.44.8.
