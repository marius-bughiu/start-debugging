---
title: "How to test a Flutter widget at a fixed point in time without a withClock closure"
description: "Inside testWidgets the ambient clock from package:clock is already fake, but it starts at whatever wall time the test began. Pin it for a whole suite by overriding runTest on a custom AutomatedTestWidgetsFlutterBinding installed from flutter_test_config.dart. Verified on Flutter 3.44.2, clock 1.1.2, fake_async 1.3.3."
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
---

If a widget renders "3 hours ago" or greets you with "Good evening", you need its notion of `now` to be a constant before you can assert on the output. The usual advice is to wrap every test body in `withClock(Clock.fixed(...), () async { ... })`, which gets noisy fast. There is a better way, and it starts with a fact most people get wrong: **inside `testWidgets` the ambient `clock` from `package:clock` is already fake**. `FakeAsync.run` installs it for you, and it only advances when you call `tester.pump`. What it does not do is start at a predictable instant, because `FakeAsync()` seeds itself from the real wall clock. Fix that one seed and the whole suite becomes deterministic with no per-test closure. Everything below was run against Flutter 3.44.2 (Dart 3.12.2), `clock` 1.1.2 and `fake_async` 1.3.3.

## What clock.now() actually returns inside testWidgets

Start with the smallest possible probe. No configuration files, no custom bindings:

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

Output from `flutter test`:

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

Two things to read off that. The delta between the two `clock.now()` calls is *exactly* one hour, to the microsecond, which no real clock ever produces. And `DateTime.now()` moved 94 milliseconds, which is how long the test actually took. So `clock` is fake and `DateTime.now()` is real.

The plumbing is in `fake_async`. `FakeAsync.run` wraps its callback in `withClock` itself:

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

And `AutomatedTestWidgetsFlutterBinding.runTest` (in `packages/flutter_test/lib/src/binding.dart`) runs the whole test body inside exactly that:

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

Note the two distinct clocks. `fakeAsync.getClock(DateTime.utc(2015))` is stored as the binding's own clock, which is why `tester.binding.clock.now()` reports `2015-01-01T00:00:00.000Z` in a fresh test and advances with `pump`:

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

The clock your widgets see through `package:clock` is a *different* `Clock` over the same `FakeAsync`, and its origin comes from the `FakeAsync` constructor:

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()`. The binding calls `FakeAsync()` with no argument, so the fake clock's origin is whatever the *ambient* clock said at the moment the test started. Outside any zone that is the system clock. That is the only piece of non-determinism, and it is the piece you get to control.

## Why withClock in flutter_test_config.dart does nothing

The most common suggestion for suite-wide setup is `flutter_test_config.dart`. It looks like it should work:

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

Two traps here. The first is a compile error if you write the obvious `return withClock(fixed, testMain)`: `withClock<T>` infers `T` from the return type, so it demands a `Future<void> Function()` while `testExecutable` hands you a `FutureOr<void> Function()`. You have to insert your own closure.

The second trap is that even once it compiles, it has no effect. Adding prints on both sides makes the ordering obvious:

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

The zone covers the top-level `main()` of the test file, which only *declares* tests with `test` and `testWidgets`. `package:test` runs each declared body later, from its own zone lineage, long after `testExecutable` has returned. `withClock` is zone-scoped, so a zone that has already exited cannot influence anything. Any blog post telling you to wrap `testMain` in `withClock` was never verified.

What `flutter_test_config.dart` *is* good for is running code once before the suite. Constructing a binding is exactly that kind of code.

## The three steps to pin the clock for a whole suite

1. Declare the packages you are about to import. `clock` goes in `dependencies` because production code will call `clock.now()`; add `meta` to `dev_dependencies` only if you also want the `@isTest` annotation from the last section, otherwise the analyzer reports `depend_on_referenced_packages`.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. Subclass `AutomatedTestWidgetsFlutterBinding` and override `runTest` so that `super.runTest` executes inside a fixed-clock zone. This is the whole trick: `super.runTest` is what constructs `FakeAsync()`, and `FakeAsync` reads the ambient clock for its `initialTime`.

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. Instantiate the binding from `testExecutable`, before any test runs. `TestWidgetsFlutterBinding.ensureInitialized()` returns `_instance ?? binding.ensureInitialized(...)`, and the `AutomatedTestWidgetsFlutterBinding` constructor sets `_instance` through `initInstances`, so whichever binding is constructed first wins. `testWidgets` will pick up yours.

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

That is it. No changes to any test file. A widget that reads the ambient clock:

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

now renders identically on every machine and every run:

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

And because you seeded `FakeAsync` rather than replacing its clock, fake time still moves under your control:

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` is wired to the same fake clock, so `pump(Duration(seconds: 42))` produces an elapsed of exactly `0:00:42.000000`. Every test starts back at the epoch, because `runTest` builds a fresh `FakeAsync` each time.

## Fixed start versus frozen: where you put withClock decides

There is a second variant, and the difference is one line of nesting. Wrap `testBody` instead of `super.runTest`, and your zone is established *inside* `FakeAsync.run`, so it shadows the fake clock entirely:

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

Now `pump` moves the framework's animation time forward but `clock.now()` never budges:

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

Neither variant interferes with animations, because `Ticker` and `SchedulerBinding` drive off frame timestamps from `FakeAsync`, not off `package:clock`. A `showDialog` plus `pumpAndSettle` under the frozen binding still resolves and finds the dialog. Pick by what you are asserting:

| | Wrap `super.runTest` | Wrap `testBody` |
| --- | --- | --- |
| Start instant | fixed | fixed |
| Advances with `pump` | yes | no |
| Mechanism | seeds `FakeAsync.initialTime` | shadows `FakeAsync`'s clock |
| Good for | relative timestamps, countdowns, debounce | "Good evening" greetings, date formatting |

One thing to avoid: do not build a lazy clock that delegates to the binding's own clock, as in `withClock(Clock(() => this.clock.now()), ...)`. `FakeAsync`'s constructor calls `clock.now()` before the binding has entered the test, and `AutomatedTestWidgetsFlutterBinding.clock` asserts `inTest`:

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

A plain `Clock.fixed` avoids the whole problem.

## A per-test wrapper when you only need it in a few files

If a custom binding is more machinery than you want, write the closure once as a wrapper. The `@isTest` annotation from `package:meta` keeps the analyzer and IDE test discovery happy:

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

Because the wrapper's zone spans the entire test body, every rebuild during the test sees the fixed clock, including ones triggered by `tap` and `setState` after an `await`. That is the crucial difference from wrapping only part of a test. If you write `await withClock(fixed, () async { await tester.pumpWidget(w); })` and then rebuild the widget after the closure exits, the rebuild escapes the zone and silently falls back to the fake-but-wall-seeded clock. I measured that: inside the closure the widget rendered `2026-03-14T09:26:53.000Z`, and a `pumpWidget` after it rendered `2026-08-24T09:15:30.029972`.

A local `withClock` still overrides the binding-wide one, so the two techniques compose. Under `FixedStartBinding`, a test that wraps its body in `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))` renders `2031-05-02T07:00:00.000Z`.

## DateTime.now() is not fakeable, and no binding will save you

`package:clock` is pure zone lookup. Its entire implementation of the top-level getter is:

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

There is no settable global. There is also nothing analogous for `DateTime.now()`, which goes straight to the VM. A widget that calls it ignores fake time completely, even a full year of it:

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

Six microseconds apart, both real. So if your widget or your model calls `DateTime.now()` directly, none of the above helps. Either migrate those call sites to `clock.now()`, or take the clock as a dependency and skip zones entirely:

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

Injection is the approach I reach for in new code, for the same reason [TimeProvider and FakeTimeProvider beat ambient statics in .NET](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/): the dependency is visible in the constructor instead of hidden in a zone. The binding override is the pragmatic answer for an existing codebase that already leans on `clock.now()`, or for third-party packages you cannot edit.

If you are on Riverpod, a `Provider<Clock>` overridden in the test's `ProviderScope` is the same idea with the wiring you already have, and it plays nicely with the patterns in [Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/).

## Four gotchas worth knowing before you commit this

**Plain `test()` bodies get the real clock.** `FakeAsync` only exists inside `testWidgets`, so a `test('...')` in the same file reports wall time for both `clock.now()` and `DateTime.now()`. If you need a fixed clock in unit tests too, wrap those bodies with `withClock` or use `fakeAsync` from `package:fake_async` directly.

**`integration_test` and `flutter run`-driven tests are real-time.** When `FLUTTER_TEST` is absent, `flutter_test` selects `LiveTestWidgetsFlutterBinding`, whose clock is hardcoded:

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

No `FakeAsync`, no fake clock. Keep the config file in `test/` rather than at the project root, because the discovery walk checks for `flutter_test_config.dart` in a directory before it checks that directory for the `pubspec.yaml` sentinel: a root-level config also applies to `integration_test/`, where constructing an `AutomatedTestWidgetsFlutterBinding` would fight with `IntegrationTestWidgetsFlutterBinding`. Do not rely on a pinned clock in integration tests.

**Config file discovery is nearest-first.** `flutter_tools` walks up from the test file looking for `flutter_test_config.dart` and stops at the first directory containing a `pubspec.yaml`. So `test/frozen/flutter_test_config.dart` shadows `test/flutter_test_config.dart` for everything under `test/frozen/`, and only one config file ever applies to a given test. That is how you can run a frozen-clock suite and a fixed-start suite side by side, but it also means you cannot layer them.

**Web works the same way.** `flutter test --platform chrome` routes through `_binding_web.dart`, whose `ensureInitialized` also returns `AutomatedTestWidgetsFlutterBinding.ensureInitialized()`, and the web bootstrap calls `testExecutable` too. The custom binding applies unchanged.

The mental model worth keeping: `testWidgets` already gives you a fake clock, `FakeAsync` decides where it starts, and the only lever on that decision is the ambient clock at the moment `runTest` builds the `FakeAsync`. Everything else is a matter of choosing which side of `super.runTest` your `withClock` sits on.

## Related

- [How to test time-dependent code with TimeProvider and FakeTimeProvider in .NET 11](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) covers the same problem in the .NET ecosystem, where the abstraction ships in the BCL.
- [How to guard setState with the mounted check after an async gap in Flutter](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) is the other half of writing widget tests that survive `await` boundaries.
- [How to cancel a StreamSubscription in dispose in Flutter](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) matters here because a pending timer at teardown trips the same `_verifyInvariants` assertion that pending fake timers do.
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier in Flutter](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) for wiring an injected clock through a provider override instead of a zone.
- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) for the class of test failures that show up once fake time starts moving in large jumps.

## Sources

- [`package:clock` API docs](https://pub.dev/documentation/clock/latest/) and the [`withClock` implementation](https://pub.dev/packages/clock), version 1.1.2.
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3, in particular the `FakeAsync` constructor and `FakeAsync.run`.
- [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) and [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html) in the Flutter 3.44 API reference.
- [The `flutter_test` library docs](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html) for `flutter_test_config.dart` and `testExecutable`.
- Flutter SDK source at tag 3.44.2: `packages/flutter_test/lib/src/binding.dart`, `packages/flutter_test/lib/src/_binding_web.dart`, and `packages/flutter_tools/lib/src/test/test_config.dart`.
