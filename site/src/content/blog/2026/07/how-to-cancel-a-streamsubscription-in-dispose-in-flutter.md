---
title: "How to cancel a StreamSubscription in dispose to avoid a setState-after-dispose crash in Flutter"
description: "A stream keeps emitting after the user leaves the screen, its onData calls setState on a disposed State, and Flutter throws. Store the subscription, cancel it in dispose before super.dispose, and the callback can never fire on a dead widget. The full pattern for Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
---

When you call `stream.listen(...)` inside a `State`, you own the subscription, and you must cancel it in `dispose()`. If you do not, the stream keeps delivering events after the user leaves the screen, the `onData` callback runs `setState` on a `State` that is already disposed, and Flutter throws `setState() called after dispose()`. The fix is three lines: store the `StreamSubscription` in a field, create it in `initState`, and call `_sub.cancel()` in `dispose()` before `super.dispose()`. Cancelling stops delivery, so the callback never fires on a dead widget in the first place. This guide uses Flutter 3.44 (current stable, 2026) and Dart 3.x.

The distinction that matters: cancelling is the real fix, and a `mounted` guard is only a patch over the symptom. A `StreamSubscription` is a live pipe between a source that outlives your widget (a `StreamController`, a Firestore snapshot listener, a WebSocket, a sensor, `connectivity_plus`) and a callback that captures `this`. As long as that pipe is open, your `State` is reachable and your `onData` runs on every event, disposed or not. Closing the pipe is the point where the leak and the crash both go away.

## Why the callback outlives the widget

Flutter's widget lifecycle and a stream's lifecycle are completely independent. The framework disposes your `State` when its element leaves the tree: the user pops the route, a parent rebuilds you out of existence, a tab switches. None of that touches the stream. The `StreamController` on the other end has no idea a widget was listening, let alone that the widget is gone. It keeps producing events, and Dart keeps dispatching them to every registered subscription, including yours.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _PriceTickerState extends State<PriceTicker> {
  double _price = 0;

  @override
  void initState() {
    super.initState();
    priceStream.listen((value) {   // subscription is never stored
      setState(() => _price = value); // runs even after dispose()
    });
  }
}
```

This code passes every quick test, because in a quick test you do not leave the screen while an event is in flight. Push a new route while `priceStream` is still emitting once a second, and the next tick lands in `onData`, which calls `setState` on a defunct `State`. In debug you get a `FlutterError`: `setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)`. The subscription returned by `listen` was thrown away, so there is no handle to cancel and nothing to stop the event. The `State` cannot be garbage collected either, because the stream's internal subscription list still references the closure that captured it. That is the same ownership bug behind [disposing controllers to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): a resource you created and never released.

## The pattern, step by step

### Step 1: Store the subscription in a field

`listen` returns a `StreamSubscription<T>`. Keep it. That handle is the only way to cancel later.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

Use a nullable field (`StreamSubscription<double>?`) when the subscription is created conditionally, so `dispose` can call `_sub?.cancel()` safely. If you always subscribe exactly once in `initState`, a `late final StreamSubscription<double> _sub;` is cleaner because it documents that the field is always assigned and lets you cancel unconditionally.

### Step 2: Subscribe in initState, not build

Create the subscription in `initState` (or `didChangeDependencies` if the stream comes from an inherited widget), never in `build`. `build` runs on every frame, so subscribing there stacks up a new listener each rebuild, and every one of them fires `setState`, which schedules another build. That feedback loop is a separate class of bug from the one this post is about, and it surfaces as [setState() or markNeedsBuild() called during build](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

```dart
// Flutter 3.44, Dart 3.x
@override
void initState() {
  super.initState();
  _sub = priceStream.listen(
    (value) => setState(() => _price = value),
    onError: (Object e, StackTrace s) => setState(() => _price = -1),
  );
}
```

### Step 3: Cancel in dispose, before super.dispose

This is the line that actually fixes the crash.

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

Order matters the same way it does for controllers: release your own resources first, then hand control up to the framework with `super.dispose()`. After `cancel()` returns, the subscription is dead. It will not deliver any further `onData`, `onError`, or `onDone` callback, even for events the source has already produced but not yet dispatched. That is the guarantee you are buying: the closure that calls `setState` can no longer run, so the disposed `State` is untouchable.

## Why you do not await cancel in dispose

`StreamSubscription.cancel()` returns a `Future<void>`, and `dispose()` returns `void`, so you cannot `await` it. This trips people up, but it is not a problem. The future completes when the stream's `onCancel` callback finishes any teardown it needs (closing a socket, releasing a file handle). Delivery to your callback stops immediately regardless of when that future resolves. For the purpose of not calling `setState` on a dead widget, the un-awaited `cancel()` is fully effective the moment it is called.

The future only matters if you specifically need to know when the source finished cleaning up, which is rare inside a widget. If you own the `StreamController` yourself and want to guarantee its `onCancel` ran before proceeding, do that teardown outside `dispose` where you can await.

## Multiple subscriptions in one widget

A screen often listens to several streams: connectivity, a data feed, a keyboard-visibility stream. Cancel every one. Two clean approaches.

Separate fields when the subscriptions are of different types and you reference them individually:

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<ConnectivityResult>? _connSub;
StreamSubscription<Order>? _orderSub;

@override
void dispose() {
  _connSub?.cancel();
  _orderSub?.cancel();
  super.dispose();
}
```

A list when you just need to tear them all down together:

```dart
// Flutter 3.44, Dart 3.x
final _subs = <StreamSubscription<dynamic>>[];

@override
void initState() {
  super.initState();
  _subs.add(connectivity.onConnectivityChanged.listen(_onConn));
  _subs.add(orders.stream.listen(_onOrder));
}

@override
void dispose() {
  for (final s in _subs) {
    s.cancel();
  }
  super.dispose();
}
```

The list scales without you having to remember to add a matching `cancel` line for each new field, which is exactly the kind of omission that reintroduces the crash months later.

## Re-subscribing without leaking the old subscription

If the stream you listen to depends on a widget property or an inherited value, the source can change while the widget stays mounted. Handle it in `didUpdateWidget` or `didChangeDependencies`, and cancel the previous subscription before opening a new one. Skipping the cancel leaks the old one and keeps its `setState` alive on the same `State`.

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(PriceTicker old) {
  super.didUpdateWidget(old);
  if (old.symbol != widget.symbol) {
    _sub?.cancel();                       // drop the old stream
    _sub = priceStreamFor(widget.symbol)  // subscribe to the new one
        .listen((v) => setState(() => _price = v));
  }
}
```

## When you own the StreamController, close it too

Cancelling a subscription and closing a controller are different responsibilities. Cancel your subscription when you are only a consumer of someone else's stream. If your widget also created the `StreamController` that backs the stream, close the controller in `dispose` as well, otherwise the controller and its buffer leak.

```dart
// Flutter 3.44, Dart 3.x
final _controller = StreamController<String>();
StreamSubscription<String>? _sub;

@override
void initState() {
  super.initState();
  _sub = _controller.stream.listen((msg) => setState(() => _last = msg));
}

@override
void dispose() {
  _sub?.cancel();       // stop consuming
  _controller.close();  // release the source you own
  super.dispose();
}
```

A single-subscription controller will not let a second listener attach, so if you also expose this stream elsewhere, create it with `StreamController.broadcast()`, and remember that every listener on a broadcast stream needs its own `cancel`.

## Why StreamBuilder is often the better answer

If the only thing your subscription does is feed a value into the UI, you probably do not need to manage a subscription at all. `StreamBuilder` subscribes when it is inserted, rebuilds on each event through its `builder`, and cancels automatically when it is removed from the tree. There is no `setState`, no field, no `dispose` bookkeeping, and therefore no way to leave a subscription running past disposal.

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

Reach for a manual `listen` plus `setState` only when the event does something other than render: navigating on a completion event, showing a `SnackBar`, writing to another controller, triggering a side effect. Those are exactly the cases where a stale callback is dangerous, and exactly where cancelling in `dispose` is non-negotiable. The same manual-versus-managed tradeoff shows up with `TextEditingController`, which is why [a controller used after being disposed](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) throws the analogous error.

## pause is not cancel, and mounted is not a substitute

Two shortcuts look like they solve this and do not.

`StreamSubscription.pause()` stops delivery temporarily, but a paused subscription is still registered and still holds your `State`. Pausing in `dispose` leaks; you must `cancel`.

A `if (!mounted) return;` at the top of `onData` prevents the `setState` call, but it does not stop the stream. The subscription stays alive, keeps dispatching events, and keeps your `State` reachable. The crash is masked while the leak continues. Use the `mounted` guard only for the case it is designed for, an `await` inside the callback that resumes after the widget is gone, and cover that thoroughly by learning to [guard setState with the mounted check after an async gap](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). For the plain "stream keeps emitting" case, cancel is the correct and complete fix.

If your `onData` is itself async, you can hit both problems at once: the subscription delivers an event, you `await` inside the handler, and the widget disposes during the await. Cancel handles the delivery; the `mounted` check handles the resume after the await. Belt and suspenders is warranted there.

## The one-file version to copy

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class PriceTicker extends StatefulWidget {
  const PriceTicker({super.key, required this.stream});
  final Stream<double> stream;

  @override
  State<PriceTicker> createState() => _PriceTickerState();
}

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.stream.listen(
      (value) => setState(() => _price = value),
      onError: (Object e, StackTrace s) => setState(() => _price = -1),
    );
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_price.toStringAsFixed(2));
}
```

Store the subscription, cancel it before `super.dispose()`, and the `setState()-after-dispose()` crash is structurally impossible rather than probabilistically avoided. Streaming state that comes from the network deserves the same care on the error path, which is worth pairing with a look at how to [handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) so a failed stream shows a state the user can act on instead of a spinner that never resolves.

## Sources

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - the cancel contract and its `Future<void>` return.
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - automatic subscribe and unsubscribe tied to the widget lifecycle.
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - single-subscription versus broadcast streams and listener management.
