---
title: "How to write a Dart isolate for CPU-bound work"
description: "When async/await is not enough: spawn a Dart isolate to run CPU-bound work off the UI thread. Isolate.run, Flutter's compute, long-lived workers with SendPort/ReceivePort, what can cross the boundary, and the JS/web caveat. Tested on Dart 3.11 and Flutter 3.27.1."
pubDate: 2026-05-05
template: how-to
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
---

Short answer: for a one-shot computation, call `await Isolate.run(myFunction)` (Dart 2.19+) or `await compute(myFunction, arg)` in Flutter. For a worker that handles many requests, use `Isolate.spawn` with a `ReceivePort` on each side and pipe messages through a `SendPort`. The function you hand to the isolate must be a top-level or `static` function, the message and the result must be sendable, and on the web `compute` runs on the event loop because dart2js does not have real isolates. Tested on Dart 3.11 and Flutter 3.27.1 with Android Gradle Plugin 8.7.3.

Async in Dart is not parallelism. `Future`, `await`, and `Stream` schedule work on the same single-threaded event loop your UI runs on. If a synchronous step inside that future spends 80 ms parsing a 4 MB JSON document or hashing a file, the loop blocks for 80 ms, the GPU misses two 60 fps frames, and `Skipped 5 frames!` shows up in your logs. An isolate is how Dart escapes the single thread: a separate VM heap with its own event loop, its own garbage collector, and no shared memory with the calling isolate. You move the work there, get the answer back, and the UI thread keeps drawing.

## When an isolate is the right tool

The expensive operation must be **synchronous CPU work**, not a long network call. Wrapping `http.get` in an isolate buys you nothing because `http.get` is already async and yields to the event loop while waiting on the socket. Real candidates:

- Parsing a JSON payload over ~1 MB. `jsonDecode` is synchronous and scales linearly with payload size.
- Image decode and resize using `package:image`. Pure Dart, no platform plugin, and a 12 MP JPEG takes hundreds of milliseconds.
- Cryptographic hashing of a file (SHA-256 over a buffered stream, BCrypt for password verification).
- Regex over a large document, especially with `multiline: true` and lookbehinds.
- Compression / decompression with `package:archive`.
- Numerical work: matrix multiplication for a small ML model, FFT, image kernel convolution.

If you cannot point at a stack frame that runs synchronously for more than ~16 ms (the budget of a 60 fps frame), an isolate will not help. Profile with the Flutter DevTools CPU profiler first; the "UI thread" timeline is the one to look at.

## The cheapest path: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` was added in Dart 2.19 and is the API the docs steer you toward in 2026. It spawns an isolate, runs the callback, ships the result back without a copy on the VM, and tears the isolate down.

```dart
// Dart 3.11
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

Future<List<dynamic>> parseLargeJson(File file) async {
  final text = await file.readAsString();
  return Isolate.run(() => jsonDecode(text) as List<dynamic>);
}
```

Two things are happening here. First, the file read stays on the calling isolate because `readAsString` is already async and does not block the event loop. Second, `jsonDecode` runs in a fresh isolate and the resulting `List<dynamic>` comes back across the boundary. Spawning an isolate costs roughly 1 to 3 ms on a modern phone, so this is only worth it when the work itself is at least ten times that.

A common mistake is passing a closure that captures the surrounding scope:

```dart
// Dart 3.11 - works, but copies state you did not intend to send
Future<int> countWordsBuggy(String text, Set<String> stopWords) async {
  return Isolate.run(() {
    return text
        .split(RegExp(r'\s+'))
        .where((w) => !stopWords.contains(w))
        .length;
  });
}
```

The closure captures `text` and `stopWords`, so both are copied to the new isolate. That is fine for small inputs, but if `text` is 50 MB you just paid 50 MB of allocation and a serialisation pass. Worse, if the captured state contains an unsendable object (an open `Socket`, a `DynamicLibrary`, a `ReceivePort`, anything tagged `@pragma('vm:isolate-unsendable')`) you will get a runtime `ArgumentError` from the spawn call. The fix is either to keep the captured state minimal, or to bind a top-level entry point and pass arguments explicitly.

## Flutter's compute, and what it actually is

`compute<M, R>(ComputeCallback<M, R> callback, M message)` from `package:flutter/foundation.dart` predates `Isolate.run` and is still the most-cited API in Flutter tutorials. As of Flutter 3.27.1 it is documented as equivalent to `Isolate.run(() => callback(message))` on native platforms. On the web target it runs the callback synchronously on the same event loop because dart2js compiles to JavaScript and there are no real isolates in the browser; you are not getting parallelism on web no matter what API you call.

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/foundation.dart';

List<Person> _parsePeople(String body) {
  final raw = jsonDecode(body) as List<dynamic>;
  return raw.cast<Map<String, dynamic>>().map(Person.fromJson).toList();
}

Future<List<Person>> fetchPeople(http.Client client) async {
  final res = await client.get(Uri.parse('https://api.example.com/people'));
  return compute(_parsePeople, res.body);
}
```

`_parsePeople` is a top-level function, not a closure or a method. That is the rule that bites people most often: the callback you hand to `compute` (or `Isolate.spawn`) has to be a top-level or `static` function so that only its identity is sent across, not its enclosing scope. If you write `compute(this._parsePeople, body)` you will hit the same closure-capture trap as before, plus you may end up trying to send the entire enclosing widget tree.

## Long-lived workers: Isolate.spawn with bidirectional ports

`Isolate.run` is one-shot. If you want a worker that handles many requests (a search index that loads 200 MB once, then answers 50 queries) you need `Isolate.spawn` plus your own protocol on top of `SendPort` / `ReceivePort`.

The pattern is symmetric: each side opens a `ReceivePort` and sends the matching `SendPort` to the other side, then both sides talk over those ports.

```dart
// Dart 3.11
import 'dart:async';
import 'dart:isolate';

class SearchWorker {
  late final SendPort _toWorker;
  late final ReceivePort _fromWorker;
  final Map<int, Completer<List<int>>> _pending = {};
  int _nextId = 0;

  static Future<SearchWorker> start(List<String> corpus) async {
    final fromWorker = ReceivePort('search.fromWorker');
    await Isolate.spawn(_entry, [fromWorker.sendPort, corpus],
        debugName: 'search-worker');
    final ready = Completer<SendPort>();
    final iter = StreamIterator(fromWorker);
    if (await iter.moveNext()) ready.complete(iter.current as SendPort);

    final w = SearchWorker._();
    w._toWorker = await ready.future;
    w._fromWorker = fromWorker;
    fromWorker.listen(w._onMessage);
    return w;
  }

  SearchWorker._();

  Future<List<int>> query(String term) {
    final id = _nextId++;
    final c = Completer<List<int>>();
    _pending[id] = c;
    _toWorker.send([id, term]);
    return c.future;
  }

  void _onMessage(dynamic msg) {
    final list = msg as List;
    final id = list[0] as int;
    final hits = (list[1] as List).cast<int>();
    _pending.remove(id)?.complete(hits);
  }

  void dispose() {
    _toWorker.send(null); // sentinel
    _fromWorker.close();
  }
}

void _entry(List args) async {
  final replyTo = args[0] as SendPort;
  final corpus = (args[1] as List).cast<String>();
  final inbound = ReceivePort('search.inbound');
  replyTo.send(inbound.sendPort);

  await for (final msg in inbound) {
    if (msg == null) {
      inbound.close();
      break;
    }
    final list = msg as List;
    final id = list[0] as int;
    final term = (list[1] as String).toLowerCase();
    final hits = <int>[];
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].toLowerCase().contains(term)) hits.add(i);
    }
    replyTo.send([id, hits]);
  }
  Isolate.exit();
}
```

A few things worth pointing out. The handshake (worker creates an inbound `ReceivePort`, sends its `SendPort` back through the port the host gave it) is boilerplate but unavoidable: there is no global registry of isolate ports. The `_pending` map plus monotonic id is what lets you have multiple in-flight queries; without ids you can only serialise requests. The sentinel `null` shuts the worker down cleanly, and `Isolate.exit()` is faster than letting `main` return because it sends the last message without copying.

If you want pause / resume or kill semantics, capture the `Isolate` returned by `Isolate.spawn` and call `isolate.kill(priority: Isolate.immediate)`. Be aware that `kill` does not run finalizers in the worker, so any open file or DB handle the worker held will leak until process exit.

## What can cross the boundary

Most Dart objects can be sent. The exceptions, as of Dart 3.11, are:

- Objects with native resources: `Socket`, `RawSocket`, `RandomAccessFile`, `Process`.
- `ReceivePort`, `RawReceivePort`, `DynamicLibrary`, `Pointer`, all `dart:ffi` finalizers.
- Anything annotated `@pragma('vm:isolate-unsendable')`.
- Closures that capture unsendable state. The capture is checked transitively, so a closure that references a class instance that holds a `Socket` field is also unsendable.

Sendable types include all primitives, `String`, `Uint8List` and the other typed lists, `List`, `Map`, `Set`, `DateTime`, `Duration`, `BigInt`, `RegExp`, and any class instance whose fields are themselves sendable. Sending a typed-data buffer copies it across the heap unless you wrap it in `TransferableTypedData`, which gives you a zero-copy hand-off:

```dart
// Dart 3.11
import 'dart:typed_data';
import 'dart:isolate';

Future<int> sumBytes(Uint8List bytes) async {
  final transferable = TransferableTypedData.fromList([bytes]);
  return Isolate.run(() {
    final view = transferable.materialize().asUint8List();
    var sum = 0;
    for (final b in view) {
      sum += b;
    }
    return sum;
  });
}
```

`materialize()` is one-shot per `TransferableTypedData`, so the sender loses access to the buffer once the worker materialises it. That is the whole point: the memory is moved, not duplicated. For payloads above a few megabytes the difference between `TransferableTypedData` and a plain copy is the difference between 1 ms and 30 ms.

## Gotchas that catch every team

**Closures capture more than you think.** Even an empty closure inside a method captures `this`. If `this` is a `StatefulWidget`'s state, you have just pinned the entire widget subtree on the worker isolate's heap until the call finishes. Always pull the data you need into local variables and pass them as arguments to a top-level function.

**Spawning is not free.** A bare `Isolate.run` with a no-op callback costs around 2 ms on a Pixel 7 and 4 to 6 ms on an older Android device. If you find yourself doing `compute` 60 times a second to process taps you have written your own bottleneck. Either batch the work, or build a long-lived worker.

**The web target is a lie for parallelism.** `compute` and `Isolate.run` both fall back to running on the current event loop on web, because Dart compiled to JavaScript runs in a single browser thread. If web parallelism matters, you need a real Web Worker, written separately, with its own message protocol. There is ongoing work on `dart:js_interop` worker support, but as of Dart 3.11 it is not a drop-in replacement for `Isolate.run`.

**`debugPrint` from a worker can interleave.** Each isolate has its own `print` pipeline. On Android the order in `logcat` is best-effort. If you are debugging a race, attach a sequence number to every log line in the worker so you can re-sort offline.

**Don't share state by reference.** A common bug pattern is to assume that a `Map` you sent into an isolate is "the same" map. It is not; the worker received a deep copy. Mutating it in the worker has no effect on the caller. Treat every isolate boundary as a serialisation boundary.

## How this fits with the rest of your Flutter pipeline

For Flutter projects specifically, the surrounding pieces matter as much as the isolate itself. Profile cold-start cost in DevTools before you reach for spawning, since first-frame work tends to dominate on lower-end Android. If you write a long-lived worker that loads native resources, the same threading rules apply as when you [reach into platform code with method channels](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), because `MethodChannel` calls from a worker isolate are not supported on Android (only the root isolate has the binary messenger by default). For reproducibility across CI, pin both Flutter and Dart explicitly and run isolate-heavy tests on each version you ship; the [matrix CI workflow](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) is the cheapest way to catch a regression where the spawn cost or the codec changed under you. And when you debug a worker that hangs, the [iOS-from-Windows device workflow](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) covers attaching the observer port across the network so you can see worker stack frames live.

The shortest version of the rule: if you wrote `await` and the UI still freezes, you have synchronous work somewhere in the awaited chain. `Isolate.run` for a single call, `compute` if you live inside Flutter and want one less import, `Isolate.spawn` plus your own port protocol when the worker has setup state worth keeping warm. Everything else (the type tables, the closure traps, the web caveat) is the bookkeeping around those three choices.

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)
