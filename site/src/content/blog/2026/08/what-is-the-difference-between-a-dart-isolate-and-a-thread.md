---
title: "What is the difference between a Dart isolate and a thread?"
description: "A thread shares memory with every other thread in the process. A Dart isolate does not: it owns its heap, runs one event loop, and talks to other isolates only by messages. Here is what that means at the VM level, where isolate groups blur the line, and how it plays out in Flutter, FFI, and on the web."
pubDate: 2026-08-29
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "threading"
---

A thread is an execution context that shares the process heap with every other thread, which is why threaded code needs locks, atomics, and memory barriers. A Dart isolate is an execution context that owns its own memory and runs a single event loop, and the only way it can reach another isolate is by sending a message through a port. The practical consequence is that Dart has no `lock` keyword, no `volatile`, and no data races on Dart objects, and the price is that everything you hand to another isolate is copied unless you use one of two escape hatches. Isolates do run on real OS threads underneath, from a pool the VM manages, but the mapping is not one to one and you never program against it. Everything below targets Dart 3.12.2 and Flutter 3.44.7.

If you are here because a computation is freezing your UI and you want the code that fixes it, the mechanics live in the guide on [writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/). This post is about the model underneath, because most isolate bugs are really a wrong mental model about what an isolate is.

## The model: one heap and one event loop per isolate

The Dart language documentation puts it in one sentence: "Isolates are like threads or processes, but each isolate has its own memory and a single thread running an event loop." Two claims are packed in there, and both matter.

Own memory means every isolate has its own copy of every global and static field. A top-level `int requestCount = 0` is not one variable in your program, it is one variable per isolate. Mutating it in a worker leaves the main isolate's copy untouched, because as the docs say, "each isolate has its own global fields, ensuring that none of the state in an isolate is accessible from any other isolate."

One event loop means an isolate processes events one at a time, forever, in a loop that conceptually looks like this:

```dart
// The Dart event loop, conceptually. Dart 3.12.
while (eventQueue.waitForEvent()) {
  eventQueue.processNextEvent();
}
```

Nothing preempts an event once it starts. A callback that spends 90ms parsing JSON holds the loop for 90ms, and every timer, every completed future, and in Flutter every frame, waits behind it. That is the opposite of a thread, which the OS scheduler can suspend mid-instruction so another thread can run.

Put the two together and you get the actor model: isolated state, sequential processing, message passing. As the docs state, "no shared state between isolates means concurrency complexities like mutexes or locks and data races won't occur."

## The race condition you cannot write in Dart

This is the clearest way to feel the difference. In C# the following is a genuine race, and fixing it requires `Interlocked` or a lock:

```csharp
// C# 14, .NET 11. Two threads, one heap, one bug.
static int _counter;

var t1 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
var t2 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
t1.Start(); t2.Start(); t1.Join(); t2.Join();
Console.WriteLine(_counter); // Not 200000. Ever, reliably.
```

The Dart translation does not race, and it also does not do what a newcomer expects:

```dart
// Dart 3.12.
import 'dart:isolate';

int counter = 0; // one copy per isolate, not one per program

void bump(int times) {
  for (var i = 0; i < times; i++) {
    counter++;
  }
}

Future<void> main() async {
  await Future.wait([
    Isolate.run(() { bump(100000); return counter; }),
    Isolate.run(() { bump(100000); return counter; }),
  ]);
  print(counter); // 0
}
```

Each spawned isolate increments its own `counter` to 100000 and then dies with it. The main isolate prints `0`. There is no torn read to hunt down and no lock to add, because there was never one variable to contend over. Every value that needs to come back has to come back as a message, which is exactly what the return value of `Isolate.run` is.

## What actually runs an isolate: the VM's thread pool

Isolates are not free-floating. The Dart VM runs them on OS threads, and the rules of that relationship are documented in the Dart VM internals write-up by Vyacheslav Egorov.

An OS thread "can enter only one isolate at a time. It has to leave current isolate if it wants to enter another isolate." And in the other direction, "there can only be a single mutator thread associated with an isolate at a time. Mutator thread is a thread that executes Dart code and uses VM's public C API."

So the invariant is one-at-a-time in both directions, not one-to-one forever. Different OS threads can execute the same isolate at different points in time, and one OS thread can serve several isolates over its lifetime. The VM does not dedicate a thread to an isolate the way `new Thread()` dedicates one to a delegate: "internally VM uses a thread pool to manage OS threads and the code is structured around ThreadPool::Task concept rather than around a concept of an OS thread." Background work such as garbage collection and JIT compilation is posted to that pool as tasks.

The takeaway for your code is that isolates are the unit you reason about and threads are an implementation detail underneath them. You cannot pin an isolate to a core, you cannot pass an isolate to a native API that expects a thread handle, and you should not assume the OS thread identity of your isolate is stable across suspension points.

## Isolate groups: the shared heap the language hides from you

Here is where "each isolate has its own memory" stops being literally true at the implementation level, which is worth knowing because it explains the performance numbers.

Since Dart 2.15 the VM organizes isolates into isolate groups. `Isolate.spawn` and `Isolate.run` create the new isolate inside the current group; only `Isolate.spawnUri` starts a fresh group with a fresh copy of the program. Inside a group, the VM shares the program structures, and as the VM internals doc puts it, isolates within a group "share the same garbage collector managed heap."

The Dart 2.15 announcement quantifies what that bought: starting an additional isolate in an existing group is "more than 100 times faster," and those isolates "consume between 10 to 100 times less memory" than before groups existed. That is why `spawnUri` is the slow path and `spawn` is the one you reach for.

The language-level guarantee is unchanged. You still cannot reach another isolate's objects, the isolation is enforced above the heap, and the shared heap is an implementation detail. But it is the reason two other things are possible.

## Copying is the price, and there are two ways out

By default, sending an object through a `SendPort` copies its whole object graph. Send a `Map` with 50000 entries and the receiving isolate gets a deep copy, and mutating it there is invisible to the sender. Most Dart objects can be sent. The documented exceptions are objects backed by native resources such as `Socket`, plus `ReceivePort`, `DynamicLibrary`, `Finalizable`, `Finalizer`, `NativeFinalizer`, `Pointer`, `UserTag`, and anything annotated `@pragma('vm:isolate-unsendable')`. Apart from those, the docs say, "any object can be sent."

The first escape hatch is `Isolate.exit`. It "terminates the current isolate synchronously" and hands over a final message, and because sender and receiver are in the same group and thus on the same heap, "this final message object graph will be reassigned to the receiving isolate without copying." No copy, at the cost of the isolate ending right there: pending `finally` blocks do not run and queued asynchronous work never runs.

You mostly get this for free. `Isolate.run`, added in Dart 2.19, is implemented on top of `Isolate.spawn` plus `Isolate.exit` precisely so the result comes back without a copy:

```dart
// Dart 3.12. One-shot work, result transferred rather than copied.
final parsed = await Isolate.run(() {
  final text = File('bulk.json').readAsStringSync();
  return jsonDecode(text) as Map<String, dynamic>;
});
```

The second escape hatch is `TransferableTypedData`, which moves ownership of a byte buffer between isolates without copying it. Use it when the payload is bytes (an image, a downloaded file, a decoded audio buffer) rather than an object graph.

If you find yourself sending large results repeatedly, note the tradeoff Flutter's own guide spells out: "there is performance overhead required to spawn new isolates, and to copy objects from one isolate to another. If you're doing the same computation using `Isolate.run` repeatedly, you might have better performance by creating isolates that don't exit immediately."

## async/await is not a thread either

The most common misconception in the neighbourhood is that `await` moves work off the current isolate. It does not. `Future`, `Stream`, and `await` are scheduling constructs on the single event loop of the isolate you are already in. Awaiting a socket read yields the loop while the OS does the I/O, which is why async is enough for network and file work. Awaiting a function that spends 200ms in a tight loop yields nothing, because there is no suspension point inside it.

The rule of thumb is short. Asynchrony is for waiting; isolates are for computing. If the expensive thing is synchronous CPU work, only an isolate gets it off the loop. If you are wiring the result back into widgets, the [FutureBuilder, StreamBuilder and Riverpod AsyncValue comparison](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) covers which async primitive to surface it with.

## Where the thread model shows through in Flutter

Flutter runs your app on the main isolate, also called the root isolate. As the Flutter docs put it, "Flutter apps do all of their work on a single isolate, the main isolate," and "all UI tasks and Flutter itself are coupled to the main isolate."

Underneath, the engine really does use several OS threads for rasterization, I/O, and platform work, and their arrangement has changed recently: as of Flutter 3.29, "the UI and platform threads are merged on iOS and Android. Specifically, the UI thread is removed and the Dart code runs on the native platform thread." That is a threading change with no isolate-level equivalent, which is a good illustration of the two layers being independent. Your Dart code did not move to another isolate, it moved to another OS thread, and nothing in the isolate model noticed.

Two consequences bite people in background isolates:

- No UI and no assets. "You can't access assets using `rootBundle` in spawned isolates, nor can you perform any widget or UI work in spawned isolates." Any `dart:ui` object belongs to the main isolate.
- Platform channels need bootstrapping. Since background isolate platform channels landed, a worker can call into Android or iOS, but only after registering with the root isolate's messenger, and it still "can't receive unsolicited messages from the host platform."

```dart
// Dart 3.12, Flutter 3.44.7. Platform channels from a background isolate.
Future<void> _isolateMain(RootIsolateToken rootIsolateToken) async {
  BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken);
  final prefs = await SharedPreferences.getInstance();
  // ... plugin calls now work here
}
```

If you are chasing dropped frames and not sure yet whether an isolate is even the answer, measure first: the walkthrough on [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) shows how to tell a long synchronous callback apart from a layout or raster problem, and the two have completely different fixes. When the work turns out to belong on the platform side instead, [adding platform-specific code without writing a plugin](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) is the cheaper route.

## FFI is where you touch real threads

The one place the thread underneath becomes visible is `dart:ffi`. A synchronous FFI call runs on whatever OS thread is currently the isolate's mutator thread, and it blocks that thread and therefore the isolate's event loop until it returns. Long native calls belong in a worker isolate for exactly the same reason long Dart loops do.

Callbacks in the other direction are constrained by the same one-isolate-per-thread rule, which is why `NativeCallable` (Dart 3.1) has different flavours. `NativeCallable.isolateLocal` "must be invoked from the same thread that created it", while `NativeCallable.listener` and `NativeCallable.isolateGroupBound` "can be invoked from any thread". If a native library calls you back from its own worker thread, `isolateLocal` is a crash waiting to happen and `listener` is the constructor you want.

## The web has neither

On the web there are no isolates at all. Dart compiled to JavaScript runs on the browser's single thread, so `compute` degrades gracefully rather than parallelizing: "on web platforms this will run callback on the current eventloop. On native platforms this will run callback in a separate isolate." Web workers are the browser's answer, but they are not a drop-in replacement, because "you can only create web workers by declaring a separate program entrypoint and compiling it separately," and they copy data across the boundary without the transfer APIs isolates have.

If a code path relies on parallelism for correctness of its frame budget, test it on web separately. It will run, and it will block.

## What is changing

The strict model has a known cost: games, physics, and image pipelines pay for copying data that logically belongs to one computation. The Dart team is exploring a selective relaxation, tracked in the shared memory multithreading umbrella issue in dart-lang/sdk, with a language proposal by Vyacheslav Egorov. The first phase covers shared native memory, with shared isolates, static fields marked `@pragma('vm:shared')` for trivially shareable types, and calling into an isolate group from an arbitrary native thread. `NativeCallable.isolateGroupBound` is the visible tip of that work.

None of this changes the default model, and as of Dart 3.12 you should treat it as experimental and read the tracking issue before designing around it. The safe assumption for production code today remains: isolates own their state, messages are copies, and `Isolate.exit` plus `TransferableTypedData` are your only zero-copy paths.

## Picking the right mental model

- Reaching for a lock means you have modelled the problem as threads. In Dart there is nothing to lock; restructure it as a message.
- Sharing a large object between two isolates is not possible. Either send a copy, transfer it once with `Isolate.exit` or `TransferableTypedData`, or keep it in one isolate and send commands to that isolate instead.
- `await` never adds a thread. Only isolates add parallelism, and only on native targets.
- Long-lived worker beats repeated `Isolate.run` when you are doing the same computation many times, because spawning and copying are not free.
- FFI, not Dart, is where thread identity matters. Pick the `NativeCallable` constructor that matches which thread the native side calls from.

## Source links

- [Concurrency in Dart](https://dart.dev/language/concurrency)
- [Concurrency and isolates, Flutter docs](https://docs.flutter.dev/perf/isolates)
- [Introduction to Dart VM, thread and isolate internals](https://mrale.ph/dartvm/)
- [Announcing Dart 2.15, isolate groups](https://dart.dev/blog/announcing-dart-2-15)
- [Better isolate management with Isolate.run](https://dart.dev/blog/better-isolate-management-with-isolate-run)
- [Isolate.exit API reference](https://api.dart.dev/stable/dart-isolate/Isolate/exit.html)
- [NativeCallable API reference](https://api.dart.dev/stable/dart-ffi/NativeCallable-class.html)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Explore shared memory multithreading, dart-lang/sdk#55991](https://github.com/dart-lang/sdk/issues/55991)
