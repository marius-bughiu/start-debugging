---
title: "Why does Future.delayed or a Timer fire later than the requested Duration in Dart?"
description: "A Dart Timer is a promise never to fire early, not a promise to fire on time. The VM truncates the Duration to whole milliseconds, adds one millisecond on purpose, and delivers the timer as an event that waits behind running code and every pending microtask. Measured lateness on Dart 3.12.2, periodic tick skipping, drift in chained delays, the 4 ms browser clamp, and the 30-day delay that fires instantly on the web."
pubDate: 2026-11-05
tags:
  - "dart"
  - "flutter"
  - "async"
  - "timers"
  - "dart-3"
---

A Dart `Timer` (and therefore `Future.delayed`, which is built on one) guarantees that its callback will not run **before** the requested `Duration` has passed. It makes no promise about how soon **after**. On the Dart VM the duration is truncated to whole milliseconds, one extra millisecond is added on purpose so the timer can never fire early, the OS wakes the event-handler thread with its own latency, and the expired timer is then delivered to your isolate as an ordinary event that waits behind whatever synchronous code is running and every microtask in the queue. On Dart 3.12.2 (macOS arm64) a `Future.delayed(Duration(milliseconds: 5))` lands at a median of 7.6 ms, and a 10 ms timer scheduled before a 200 ms synchronous loop fires at 201 ms. If you need accurate pacing, use `Timer.periodic` or compute each delay from a fixed deadline instead of chaining delays.

Everything below was run on Dart 3.12.2 (stable, `macos_arm64`) with `dart run` (JIT) and `dart compile exe` (AOT), plus `dart compile js -O2` output run under Node 26.4.0 and Chromium 152. The source quoted is the `3.12.2` tag of [dart-lang/sdk](https://github.com/dart-lang/sdk/tree/3.12.2).

## What the documentation actually promises

The `Timer` and `Future.delayed` docs in `dart:async` are carefully worded. `Future.delayed` says that for a duration of 0 or less the future "completes no sooner than in the next event-loop iteration, after all microtasks have run." `Timer.periodic` says the exact timing "depends on the underlying timer implementation" and that the gap between two callbacks "can be shorter and longer than `duration`." And the class-level note on `Timer` warns that when compiled to JavaScript, "the finest granularity available in the browser is 4 milliseconds."

None of that is a deadline. A Dart timer is a lower bound. To see where the extra time comes from, follow a timer through the VM.

## Where the lateness comes from on the Dart VM

### Step 1: the Duration becomes whole milliseconds

The VM patch for `Timer._createTimer` (`sdk/lib/_internal/vm/lib/timer_patch.dart`) does this before anything else:

```dart
// sdk/lib/_internal/vm/lib/timer_patch.dart, Dart 3.12.2
int milliseconds = duration.inMilliseconds;
if (milliseconds < 0) milliseconds = 0;
```

`inMilliseconds` truncates. `Duration(microseconds: 1999)` becomes a 1 ms timer, and `Duration(microseconds: 500)` becomes a **0 ms** timer, which takes a completely different path (see below) and runs almost immediately. Sub-millisecond durations do not exist for VM timers.

### Step 2: one millisecond is added on purpose

`_Timer._createTimer` in `sdk/lib/_internal/vm/lib/timer_impl.dart` computes the wakeup time against a millisecond monotonic clock:

```dart
// sdk/lib/_internal/vm/lib/timer_impl.dart, Dart 3.12.2
// Add one because DateTime.now() is assumed to round down
// to nearest millisecond, not up, so that time + duration is before
// duration milliseconds from now. Using microsecond timers like
// Stopwatch allows detecting that the timer fires early.
int now = VMLibraryHooks.timerMillisecondClock();
int wakeupTime = (milliSeconds == 0) ? now : (now + 1 + milliSeconds);
```

Because the clock is read in whole milliseconds, "now" can be up to 1 ms in the past. Adding 1 ms guarantees that a `Stopwatch` started at the same moment will never observe the timer firing early. The cost is that every non-zero timer is scheduled between `duration` and `duration + 1 ms` after you created it, before any other delay is counted.

### Step 3: a separate thread waits on the OS

The isolate does not sleep. The VM's event-handler thread (one per process, in `runtime/bin/eventhandler_*.cc`) keeps the earliest wakeup time per isolate and blocks in the platform's wait primitive with a millisecond timeout:

- macOS: `kevent` with a `timespec` built from the remaining milliseconds.
- Linux: a `timerfd` on `CLOCK_MONOTONIC` armed with `TFD_TIMER_ABSTIME`, watched by `epoll_wait`.
- Windows: `GetQueuedCompletionStatus` with a `DWORD` millisecond timeout.

Each of these adds the OS's own wakeup latency. On Windows that wait is bounded by the system timer resolution, which defaults to about 15.6 ms unless something in the process (or, before Windows 10 version 2004, anything in the system) has raised it with `timeBeginPeriod` ([Microsoft docs](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)). On macOS the kernel is free to coalesce timer wakeups to save power. Neither is something Dart can opt out of.

### Step 4: the timer is a message to your isolate

When the wait times out, the event handler does not run your callback. It posts a message to the isolate's internal `Timer` receive port. That message goes into the isolate's event queue like any socket read or isolate message, and is handled only when the isolate gets back to its event loop. `_runTimers` then runs every expired timer in wakeup order and, after **each** callback, drains the microtask queue (`_runPendingImmediateCallback()`).

So the isolate needs two things before your callback runs: the current synchronous code has to return, and every microtask scheduled before the timer event has to finish. This is the source of the large delays you see in practice. The model is covered in more depth in [the difference between a Dart isolate and a thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/): one isolate, one event loop, nothing preempts a running event.

### Zero-duration timers are different

A 0 ms timer (including any duration under 1 ms) never goes into the timer heap and never involves the event-handler thread. `_enqueue` puts it on a FIFO list and sends one `_ZERO_EVENT` message to the isolate's own port. It fires on the next turn of the event loop, after microtasks, which is why it costs microseconds rather than milliseconds.

## Measured: how late is a timer on an idle isolate?

This script measures `Future.delayed` 50 times per duration on an otherwise idle isolate:

```dart
// Dart 3.12.2, macOS arm64. dart run lateness.dart
import 'dart:async';

Future<double> measure(Duration d) async {
  final sw = Stopwatch()..start();
  await Future.delayed(d);
  return sw.elapsedMicroseconds / 1000;
}

Future<void> main() async {
  for (final d in [
    Duration.zero,
    const Duration(microseconds: 500),
    const Duration(microseconds: 1999),
    const Duration(milliseconds: 1),
    const Duration(milliseconds: 5),
    const Duration(milliseconds: 16),
    const Duration(milliseconds: 100),
  ]) {
    final samples = <double>[];
    for (var i = 0; i < 50; i++) {
      samples.add(await measure(d));
    }
    samples.sort();
    print('${d.inMicroseconds}us requested: '
        'min ${samples.first.toStringAsFixed(3)} ms, '
        'median ${samples[25].toStringAsFixed(3)} ms, '
        'max ${samples.last.toStringAsFixed(3)} ms');
  }
}
```

Output with `dart run` (JIT) on an Apple Silicon Mac:

```text
0us requested: min 0.005 ms, median 0.005 ms, max 1.608 ms
500us requested: min 0.004 ms, median 0.005 ms, max 0.010 ms
1999us requested: min 1.312 ms, median 2.569 ms, max 2.754 ms
1000us requested: min 1.178 ms, median 2.563 ms, max 2.698 ms
5000us requested: min 5.131 ms, median 7.615 ms, max 7.657 ms
16000us requested: min 17.245 ms, median 19.040 ms, max 19.340 ms
100000us requested: min 100.795 ms, median 103.023 ms, max 103.421 ms
```

The same program compiled with `dart compile exe` gave nearly identical numbers (5 ms: median 7.544 ms; 100 ms: median 102.459 ms), so this is not a JIT artifact. Three things stand out:

1. `Duration(microseconds: 500)` behaves exactly like `Duration.zero`: truncated to 0 ms, it takes the zero-timer path and resolves in about 5 microseconds.
2. `Duration(microseconds: 1999)` behaves exactly like `Duration(milliseconds: 1)`: the other 999 microseconds are thrown away.
3. On an idle isolate the overhead is roughly 1.5 to 3 ms on this machine. The +1 ms from step 2 is in there by design; the rest is rounding of the remaining wait to whole milliseconds and OS wakeup latency. Expect different numbers on Windows, where timer resolution dominates.

## Measured: what a busy isolate does to a timer

Idle overhead is a few milliseconds. The cases that produce bug reports are the ones where the isolate is not idle:

```dart
// Dart 3.12.2, macOS arm64. dart run blocked.dart
import 'dart:async';

void busy(int ms) {
  final sw = Stopwatch()..start();
  while (sw.elapsedMilliseconds < ms) {}
}

Future<void> main() async {
  // 1. A synchronous block delays a due timer.
  final sw = Stopwatch()..start();
  final f = Future.delayed(const Duration(milliseconds: 10),
      () => print('10 ms timer fired at ${sw.elapsedMilliseconds} ms'));
  busy(200);
  await f;

  // 2. Microtasks run before any timer gets a turn.
  sw.reset();
  final g = Future.delayed(const Duration(milliseconds: 10),
      () => print('10 ms timer behind a microtask chain fired at ${sw.elapsedMilliseconds} ms'));
  var n = 0;
  void chain() {
    if (sw.elapsedMilliseconds < 150) {
      n++;
      scheduleMicrotask(chain);
    }
  }
  scheduleMicrotask(chain);
  await g;
  print('  ($n microtasks ran first)');
}
```

```text
10 ms timer fired at 201 ms
10 ms timer behind a microtask chain fired at 150 ms
  (5965213 microtasks ran first)
```

The first case is the classic one: the timer expired at 11 ms, the event handler posted its message, and the message sat in the queue until the 200 ms loop returned. The second is less obvious and more dangerous. No single piece of code ran for 150 ms; nearly six million tiny microtasks did, each scheduling the next. Because the microtask queue is drained completely before the event loop takes the next event, a self-perpetuating microtask chain starves timers just as effectively as a busy loop. Long chains of already-completed futures (`await` on a value that is not a real async operation, `Future.value` loops, `Stream` transforms over synchronous data) have the same effect in smaller doses.

The VM notices these situations. In non-product builds (`dart run`, Flutter debug and profile), `_runTimers` calls `_postTimerEvent` whenever a timer runs 100 ms or more past its wakeup time, which emits a `TimerSignificantlyOverdue` event on the VM service `Timer` stream with a message saying that "timers were blocked from firing" by synchronous work or that the program "was frozen by the OS." Tools that subscribe to that stream can surface it. In Flutter, the same blocking shows up as jank, and the timeline in DevTools shows which frame or event held the UI isolate; see [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

The fix for blocked timers is not a different timer. It is to stop blocking the isolate: move CPU-bound work to another isolate ([how to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)), or break long synchronous loops into chunks with `await Future.delayed(Duration.zero)` between them so timers and I/O get a turn.

## Periodic timers skip ticks instead of queueing them

`Timer.periodic` handles lateness differently from a one-shot timer, and that difference is useful. In `_runTimers`, a repeating timer that is overdue by more than one period has its wakeup time advanced by whole periods and its `tick` counter bumped by the number of missed ticks, then the callback runs **once**. The next wakeup is computed as `_wakeupTime += _milliSeconds`, from the previous **scheduled** time, not from when the callback actually ran.

```dart
// Dart 3.12.2, macOS arm64
final sw = Stopwatch()..start();
Timer.periodic(const Duration(milliseconds: 50), (t) {
  print('periodic tick=${t.tick} at ${sw.elapsedMilliseconds} ms');
  if (t.tick == 2) busy(180); // block the isolate inside one callback
  if (t.tick >= 8) t.cancel();
});
```

```text
periodic tick=1 at 53 ms
periodic tick=2 at 103 ms
periodic tick=5 at 283 ms
periodic tick=6 at 303 ms
periodic tick=7 at 353 ms
periodic tick=8 at 403 ms
```

Ticks 3 and 4 were never delivered. The callback that ran at 283 ms saw `tick == 5`, matching the documented contract that `tick` counts "the number of durations that have passed and not the number of callback invocations." Then the timer snapped back onto its original 50 ms grid: tick 6 arrived only 20 ms later, at 303 ms, and the rest followed at 353 and 403. If your callback needs to know how much time passed, read `t.tick` (or a `Stopwatch`), never count invocations.

## Chained delays drift, periodic and deadline-based loops do not

Because every one-shot timer adds its own 1.5 to 3 ms of overhead, a loop of `await Future.delayed(period)` accumulates that overhead on every iteration:

```dart
// Dart 3.12.2, macOS arm64. dart run drift.dart
import 'dart:async';

Future<void> main() async {
  const period = Duration(milliseconds: 10);
  const n = 100;

  // Chained one-shot delays: every iteration adds its own lateness.
  final sw = Stopwatch()..start();
  for (var i = 0; i < n; i++) {
    await Future.delayed(period);
  }
  print('100 x Future.delayed(10 ms): ${sw.elapsedMilliseconds} ms');

  // Periodic timer: next wakeup = previous scheduled wakeup + period.
  sw.reset();
  final done = Completer<void>();
  Timer.periodic(period, (t) {
    if (t.tick == n) {
      t.cancel();
      done.complete();
    }
  });
  await done.future;
  print('Timer.periodic(10 ms) to tick 100: ${sw.elapsedMilliseconds} ms');

  // Deadline-based loop: compute each delay from a fixed start.
  sw.reset();
  for (var i = 1; i <= n; i++) {
    final target = period * i;
    final remaining = target - sw.elapsed;
    if (remaining > Duration.zero) await Future.delayed(remaining);
  }
  print('100 x deadline-corrected delay: ${sw.elapsedMilliseconds} ms');
}
```

```text
100 x Future.delayed(10 ms): 1265 ms
Timer.periodic(10 ms) to tick 100: 1007 ms
100 x deadline-corrected delay: 1002 ms
```

The chained version ran 26% long. That is the pattern behind "my countdown loses a second every minute" and "my polling loop slowly falls behind." Both fixes are simple: use `Timer.periodic` when the work is short and you want a fixed rate, or keep a `Stopwatch` (or a start `DateTime`) and compute each delay as "deadline minus now" so lateness from one iteration is subtracted from the next. For anything shown to a user, such as a countdown label, derive the displayed value from elapsed time rather than from the number of callbacks. In Flutter, anything frame-synchronized (animations, game loops) should use a `Ticker` or `AnimationController`, which are driven by the engine's vsync, rather than `Timer.periodic(Duration(milliseconds: 16))`.

## On the web: setTimeout rules apply

When compiled with dart2js or DDC, `Timer` is a thin wrapper over `setTimeout` and `setInterval` (`sdk/lib/_internal/js_runtime/lib/async_patch.dart`). The Duration is still truncated with `inMilliseconds` and then passed straight through, so the browser's own rules take over. MDN's [setTimeout page](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#reasons_for_delays_longer_than_specified) lists them; the two that matter most:

- **Nested timeouts are clamped to 4 ms.** Once timers have been nested five levels deep (a timeout scheduled from a timeout callback, and so on), the [HTML standard](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers) requires a minimum delay of 4 ms.
- **Background tabs are throttled.** Browsers delay timers in hidden tabs to at least 1 second, and Chrome adds "intensive throttling" for pages hidden long enough, aligning chained timers to one-minute intervals ([Chrome developers blog](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)).

The clamp is easy to see. This chain of zero-duration delays, compiled with `dart compile js -O2` and run in a visible Chromium 152 tab, printed:

```dart
// Dart 3.12.2, compiled with: dart compile js -O2 web.dart -o web.js
final sw = Stopwatch()..start();
final gaps = <int>[];
var last = 0;
for (var i = 0; i < 10; i++) {
  await Future.delayed(Duration.zero);
  final now = sw.elapsedMicroseconds;
  gaps.add(now - last);
  last = now;
}
print('zero-delay gaps (us): $gaps');
```

```text
zero-delay gaps (us): [599, 0, 500, 601, 399, 700, 4600, 5801, 5099, 5800]
```

The first six iterations are sub-millisecond; from the seventh on, every gap is 4.6 to 5.8 ms. That is the nesting clamp, and it is why "yield to the event loop" loops built on `Future.delayed(Duration.zero)` run far slower on the web than on the VM.

### The opposite bug: very long delays fire immediately

`setTimeout` stores its delay as a signed 32-bit integer. A delay above 2,147,483,647 ms (about 24.8 days) overflows, and browsers treat it as 0. dart2js does not guard against this, so on the web:

```dart
// Dart 3.12.2, dart compile js -O2
final sw = Stopwatch()..start();
await Future.delayed(const Duration(days: 30));
print('30-day delay completed after ${sw.elapsedMilliseconds} ms');
```

printed `30-day delay completed after 42 ms` in Chromium 152 and `after 2 ms` under Node 26.4.0 (which also logs a `TimeoutOverflowWarning` and clamps the delay to 1 ms). On the VM the same code waits the full 30 days. If a web build needs a long-lived timer, schedule it in chunks of at most a day and re-check the remaining time.

## Suspended processes and sleeping machines

A timer can only fire while the process runs. When a mobile OS suspends a backgrounded Flutter app, or a laptop goes to sleep, nothing fires until execution resumes. What happens next depends on the clock the VM uses, which differs by platform in Dart 3.12.2's `runtime/bin/utils_*.cc`:

- macOS uses `CLOCK_MONOTONIC_RAW`. The macOS `clock_gettime(3)` man page (`man clock_gettime`) says `CLOCK_MONOTONIC` continues "to increment while the system is asleep," describes `CLOCK_MONOTONIC_RAW` as tracking time "like CLOCK_MONOTONIC," and reserves the "does not increment while the system is asleep" behaviour for `CLOCK_UPTIME_RAW`. A timer that came due during sleep is overdue on wake and fires almost immediately.
- Linux uses `CLOCK_MONOTONIC`, which, per [`clock_gettime(2)`](https://man7.org/linux/man-pages/man2/clock_gettime.2.html), does not count time the system is suspended. A 10-minute timer that spans a 30-minute suspend fires about 40 minutes of wall-clock time after it was created, because the suspended half hour never counted toward it.

This part is derived from the source and the man pages, not measured for this post. If an action must happen at a wall-clock time (a reminder, a token refresh), store the target `DateTime` and re-check it when the app resumes, instead of trusting a long `Timer` to have counted real time.

## In tests, timers do not wait at all

`testWidgets` runs the test body inside a `FakeAsync` zone, so `Future.delayed` and `Timer` are driven by a fake clock that only advances when you call `tester.pump(duration)` or `tester.pumpAndSettle()`. Real elapsed time is irrelevant, and a test that "waits" with a real delay will hang or time out instead. For pure Dart tests, `package:fake_async` gives the same control. If you are controlling `DateTime.now()` as well as timers, see [how to test a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/).

## Checklist when a timer is late

1. Under about 3 ms late on the VM (more on Windows): expected. That is truncation, the deliberate +1 ms, and OS wakeup latency.
2. Tens or hundreds of milliseconds late: something is blocking the isolate. Look for long synchronous work or microtask chains, and check DevTools or the `TimerSignificantlyOverdue` service event.
3. A loop that slowly falls behind: you are chaining one-shot delays. Switch to `Timer.periodic` or deadline-based delays.
4. A periodic callback "skipped" values: read `timer.tick`, which counts elapsed periods, not invocations.
5. Only slow on the web: the 4 ms nesting clamp or background-tab throttling.
6. A long delay fired instantly on the web: the 2^31-1 ms `setTimeout` overflow.

## Related

- [What is the difference between a Dart isolate and a thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/)
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [How to test a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)
- [unawaited_futures vs discarded_futures in Dart](/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

## Sources

- [`Timer` class, dart:async API reference](https://api.dart.dev/dart-async/Timer-class.html) and [`Future.delayed`](https://api.dart.dev/dart-async/Future/Future.delayed.html)
- [`timer_impl.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/vm/lib/timer_impl.dart) and [`timer_patch.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/vm/lib/timer_patch.dart), Dart SDK 3.12.2
- [`eventhandler_macos.cc`](https://github.com/dart-lang/sdk/blob/3.12.2/runtime/bin/eventhandler_macos.cc), [`eventhandler_linux.cc`](https://github.com/dart-lang/sdk/blob/3.12.2/runtime/bin/eventhandler_linux.cc), [`eventhandler_win.cc`](https://github.com/dart-lang/sdk/blob/3.12.2/runtime/bin/eventhandler_win.cc)
- [`async_patch.dart` (dart2js timers)](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/js_runtime/lib/async_patch.dart)
- [`service_event.cc` (`TimerSignificantlyOverdue`)](https://github.com/dart-lang/sdk/blob/3.12.2/runtime/vm/service_event.cc)
- [MDN: setTimeout, reasons for delays longer than specified](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#reasons_for_delays_longer_than_specified)
- [HTML Standard: timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)
- [Chrome: heavy throttling of chained JS timers (Chrome 88)](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- [Microsoft: `timeBeginPeriod`](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)
