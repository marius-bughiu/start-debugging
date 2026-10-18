---
title: "How to Catch Uncaught Async Errors in Flutter with runZonedGuarded and PlatformDispatcher.instance.onError"
description: "FlutterError.onError only sees errors thrown inside framework callbacks. Unawaited futures, timers, streams, and code after an await go somewhere else. Here is which handler catches which error, measured on Flutter 3.44.8, and the main() setup that catches all of them, including on web."
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
---

**Short answer:** in Flutter 3.44 you need two handlers, not one. `FlutterError.onError` receives errors thrown inside framework callbacks (build, layout, paint, a synchronous `onPressed`). `PlatformDispatcher.instance.onError` receives everything else that nobody caught in the root isolate: an unawaited `Future`, a `Timer` callback, a stream with no `onError`, and any code that runs after an `await`, including the body of an `async` button handler. Set both at the top of `main()` and return `true` from the dispatcher callback. `runZonedGuarded` is the older way to catch the second group and is still the only way on Flutter web, because the web engine never calls `PlatformDispatcher.onError`. Errors thrown in an isolate you spawn yourself reach neither handler unless you pass an `onError` port.

Everything below was measured on Flutter 3.44.8 (stable) with Dart 3.12.2, running a release build of a macOS desktop app that triggers each kind of error and logs which handler received it. The handler routing is the same on Android and iOS, since it lives in the shared engine and framework code.

## Why FlutterError.onError misses async errors

Most "my crash reporter does not see this error" questions come from assuming `FlutterError.onError` is a global catch-all. It is not. The framework calls it from its own `try`/`catch` blocks: when a widget's `build` throws, when a `RenderObject` throws during layout or paint, when a gesture recognizer's callback throws, when a scheduler callback throws, and when a platform message handler throws. Each of those sites wraps the error in a `FlutterErrorDetails` with a `context` string such as "while handling a gesture" or "during a platform message callback" and hands it to `FlutterError.reportError`, which calls `FlutterError.onError`.

An error that is thrown when no framework frame is on the call stack never passes through one of those `try`/`catch` blocks. Consider this button:

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

The gesture recognizer calls `onPressed`, the closure runs up to the first `await`, returns a `Future`, and the recognizer's `try` block exits cleanly. When `api.save()` fails later, the exception completes that `Future` with an error. Nobody awaits it (the recognizer ignored the return value), so the error is "uncaught" and travels up the zone chain. In the root zone, the Flutter engine routes it to `PlatformDispatcher.instance.onError`. If that is not set, it is printed to the log and ignored. The app keeps running, which is why these errors often go unnoticed until a user reports a button that "does nothing".

## The handler matrix, measured

I built a small macOS app on Flutter 3.44.8 that, after its first frame, triggers one kind of error per run and logs which handler received it. The setup was the documented one: `FlutterError.onError` plus `PlatformDispatcher.instance.onError` in `main()`, no zones.

| What threw | Handler that received it |
| --- | --- |
| Synchronous throw in `onPressed` | `FlutterError.onError` (context: "while handling a gesture") |
| Throw in `build` | `FlutterError.onError` |
| Throw after an `await` in an `async` `onPressed` | `PlatformDispatcher.instance.onError` |
| Unawaited `Future.delayed(..., () => throw ...)` | `PlatformDispatcher.instance.onError` |
| `Timer` callback | `PlatformDispatcher.instance.onError` |
| `Stream.error(...).listen((_) {})` with no `onError` | `PlatformDispatcher.instance.onError` |
| Unawaited `MethodChannel.invokeMethod` on a missing channel | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| Unawaited `Isolate.run(() => throw ...)` | `PlatformDispatcher.instance.onError` |
| `Isolate.spawn` entry point that throws, no `onError` port | Neither. The engine printed `Unhandled exception` from `dart_isolate.cc` |
| Same, with `onError: port.sendPort` | The `RawReceivePort` listener |

`Isolate.run` lands in the dispatcher because it rethrows the child's error into the returned `Future` in the root isolate, and that `Future` was unawaited. A raw `Isolate.spawn` does not do that: the error dies with the child isolate. The engine's own doc comment on `onError` says so directly: it "is not directly invoked by errors in child isolates of the root isolate."

## The recommended main(), step by step

This is the setup that catches every row of the table on Android, iOS, macOS, Windows, and Linux.

1. Call `WidgetsFlutterBinding.ensureInitialized()` first if you do any async work before `runApp` (initialising your crash reporter, reading preferences).
2. Assign `FlutterError.onError`. Call `FlutterError.presentError(details)` inside it so the red error box and the console dump still appear in debug builds, then forward `details.exception` and `details.stack` to your reporter.
3. Assign `PlatformDispatcher.instance.onError`. Forward the error and stack, and return `true`.
4. Call `runApp`.
5. For every isolate you create with `Isolate.spawn`, pass an `onError` port and forward what arrives to the same reporter.

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

The `onError` port receives a two-element list: the error's `toString()` and the stack trace as a string. You lose the original exception type at the isolate boundary, so log the string as-is rather than trying to `is`-check it.

If you use Firebase Crashlytics, its documented setup is the same shape: `FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError` and `PlatformDispatcher.instance.onError` calling `recordError(error, stack, fatal: true)` and returning `true`. Other crash SDKs, Sentry included, install equivalent handlers during their own initialisation, so do not overwrite them afterwards without chaining to the previous handler.

## What the return value of PlatformDispatcher.onError does

The callback's return type is `bool`, and it matters. The engine documents it as: return `true` if you handled the error, otherwise return `false` and "a fallback mechanism such as printing to stderr will be used". I ran the unawaited `Future` case with the callback returning `false`. The callback ran, and then the engine also printed `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` with the full stack. With `true`, only my handler ran.

In neither case did the process exit. An uncaught Dart error in Flutter does not crash the app: the event loop carries on with the next event. That is good for users but bad for visibility, because the only symptom is a half-finished action. If you want a fail-fast policy, do it yourself in the handler (for example `if (kReleaseMode) exit(1);` as the Flutter docs show for `FlutterError.onError`), and think hard before shipping that.

## runZonedGuarded: when you still need it

Before Flutter 3.3 (August 2022) added `PlatformDispatcher.onError`, the standard advice was to wrap `runApp` in `runZonedGuarded`, so every async error raised by code running in that zone reaches its `onError` callback instead of the root zone. It still works, and I verified it catches the same rows as the dispatcher:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

With this setup, the unawaited `Future`, the throw after an `await` in `onPressed`, and the unawaited `Isolate.run` all arrived at the zone callback. The `build` error still went to `FlutterError.onError`, because the framework catches it before it can become a zone error. So the zone replaces the dispatcher, not `FlutterError.onError`.

If you set both (dispatcher assigned inside the guarded zone), the zone wins. In my run, only the `runZonedGuarded` callback fired for the unawaited `Future`, and `PlatformDispatcher.instance.onError` was never called, because the error was handled before it reached the root zone. That is harmless, but it means a crash SDK that relies on the dispatcher will see nothing for errors raised inside your zone. Pick one mechanism.

There are three reasons to keep using a zone in 2026:

- **Flutter web.** The web engine stores the callback and never calls it. In the 3.44.8 source, `lib/web_ui/lib/src/engine/platform_dispatcher.dart` has `// TODO(dnfield): make this work on web.` above the setter, and the tracking issue [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) is still open. On web, `runZonedGuarded` is the only way to catch async errors globally.
- **Zone values.** If you rely on `zoneValues` (a request-scoped logger, a test clock), you are already forking a zone and can add the error handler there.
- **Scoped handling.** A zone can wrap a single subsystem, for example a sync job, so its errors are tagged and routed separately from the rest of the app.

For a cross-platform app that also ships to web, the pragmatic setup is: assign the dispatcher handler (it covers mobile and desktop), and wrap the body of `main` in `runZonedGuarded` only when `kIsWeb` is true. Keep both callbacks pointing at the same reporter.

## The "Zone mismatch" warning

Since Flutter 3.10, debug builds check that the binding was initialised in the same zone that later calls `runApp`. This is the common broken version:

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

My debug build reported it through `FlutterError.onError` with the context "during runApp":

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

It is a warning, not a crash, and in my run the unawaited `Future` still reached the zone callback, because `initState` ran inside `runApp`'s zone. The danger is the callbacks that the binding registered with the engine while it was in the root zone: pointer events, platform messages, and frame callbacks are invoked in the zone that was current when they were registered. Errors from those paths can bypass your guarded zone, which is exactly the inconsistency the warning describes. The fix is to move `ensureInitialized()` (and any `await` that needs it) inside the `runZonedGuarded` body, as in the previous section. Set `BindingBase.debugZoneErrorsAreFatal = true` as the first statement of `main` if you want CI to fail on it.

## Gotchas that hide errors anyway

- **`catchError` that returns nothing.** `future.catchError((e) => log(e))` on a `Future<int>` throws an `ArgumentError` at runtime in Dart 3, because the handler must return a value of the future's type. Use `try`/`await`/`catch` instead.
- **`unawaited()` hides intent, not errors.** Wrapping a call in `unawaited(...)` silences the `unawaited_futures` lint, but the error still goes to the dispatcher. That is usually what you want, but do not treat it as error handling.
- **A `StreamSubscription` with no `onError`.** Every error event on such a subscription is reported as uncaught. With a long-lived stream that errors repeatedly, your reporter gets one report per event. Add `onError` to subscriptions you own, and cancel them, as covered in [the StreamSubscription dispose guide](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).
- **Native crashes.** A segfault in a plugin's Kotlin, Swift, or C code never reaches Dart. You need the native side of your crash SDK for those.
- **`flutter test`.** The test framework runs each test in its own zone and fails the test on any uncaught error, so handlers you set in `main()` are not exercised by widget tests. Test your reporting by calling the handler functions directly.
- **Handler order with SDKs.** If an SDK sets `FlutterError.onError` and you assign it again afterwards, you silently replace it. Save the previous value (`final previous = FlutterError.onError;`) and call it from your handler.

## Related

- [How to handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) covers catching errors where they happen, which is always better than relying on the global handler.
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) explains `Isolate.run` versus `Isolate.spawn`, which decides whether an isolate's error reaches the root isolate at all.
- [What is the difference between a Dart isolate and a thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) explains why errors cannot cross an isolate boundary as objects.
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) deals with the other classic bug in `async` button handlers.

## Sources

- Flutter docs: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Flutter docs: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) and [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- API reference: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)
