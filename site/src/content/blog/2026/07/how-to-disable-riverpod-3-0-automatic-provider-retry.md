---
title: "How to disable Riverpod 3.0's automatic provider retry"
description: "Riverpod 3.0 retries a failed provider up to 10 times by default. Pass a retry function that returns null on ProviderScope, ProviderContainer, or an individual provider to turn it off or bound it."
pubDate: 2026-07-20
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "async"
---

Riverpod 3.0 added automatic retry: when a provider throws while it is building, Riverpod silently retries it up to 10 times with an exponential backoff that starts at 200ms and doubles up to 6.4 seconds. To turn that off, pass a `retry` callback that returns `null`. You can do it globally on `ProviderScope` or `ProviderContainer`, or per provider on the provider constructor or the `@Riverpod` annotation. This is tested on `flutter_riverpod` 3.x (the 3.0 line shipped September 2025; the current release is 3.3.2, June 2026), Flutter 3.44, and Dart 3.x.

The one-liner, if you just want it gone everywhere:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) => null, // never retry
  child: MyApp(),
)
```

Everything else in this post is about why the retry exists, when the default is actually helping you, and how to bound it instead of killing it outright.

## Why a provider that used to fail once now fails ten times

In Riverpod 2.x, a provider whose `build` threw an exception went straight to `AsyncError` and stayed there until something invalidated it. One failure, one error state. Predictable.

Riverpod 3.0 changed that default. The reasoning is sound: a lot of provider failures are transient. A `FutureProvider` that calls an HTTP endpoint fails because the network blipped, not because the code is wrong. Retrying with backoff means the UI recovers on its own instead of parking on an error screen that a manual refresh would have cleared. The official docs describe the default as retrying "up to 10 times, with an exponential backoff going from 200ms to 6.4 seconds."

The problem is that this behaviour is invisible until it bites you. A provider that fails deterministically, say because it parses a malformed response or hits a 404 that will never become a 200, now burns through all 10 attempts before it settles into an error state. During those attempts your loading spinner keeps spinning, your logs fill with the same stack trace ten times, and any side effect inside `build` (an analytics event, a log line, a counter increment) fires ten times instead of once. In tests it is worse: a provider that is supposed to fail fast instead hangs while the retry schedule plays out, and your test times out.

## Reproducing the retry storm

Here is the smallest provider that shows the behaviour. It throws unconditionally and logs each time `build` runs.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';

int _attempts = 0;

final brokenProvider = FutureProvider<int>((ref) async {
  _attempts++;
  print('build attempt #$_attempts');
  throw StateError('this will never succeed');
});
```

Watch it from a widget:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
class Screen extends ConsumerWidget {
  const Screen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(brokenProvider);
    return value.when(
      data: (n) => Text('$n'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('failed: $e'),
    );
  }
}
```

On Riverpod 2.x the console prints `build attempt #1` once and the widget shows the error immediately. On Riverpod 3.0 the console prints ten attempts spread across roughly 13 seconds (200ms + 400ms + 800ms + ... up to 6.4s), and the spinner stays up the whole time before the error finally renders. That 13-second gap between "the request failed" and "the user sees an error" is the surprise most teams hit first.

## The retry callback, and how returning null disables it

Every retry hook in Riverpod 3.0 has the same shape. It receives the current retry count and the error, and returns a `Duration?`. Return a duration to wait that long and try again; return `null` to give up and surface the error.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? myRetry(int retryCount, Object error) {
  if (retryCount >= 5) return null;                       // cap attempts
  if (error is ProviderException) return null;            // don't retry wrapped deps
  return Duration(milliseconds: 200 * (1 << retryCount)); // 200ms, 400ms, 800ms...
}
```

`1 << retryCount` is just `2^retryCount`, so this reproduces the built-in exponential curve. To disable retry entirely, the whole function collapses to one line that ignores its arguments and always returns `null`.

### Turn it off for the whole app

`ProviderScope` is the widget that hosts your provider state in a Flutter app. Give it a `retry` and every provider under it inherits the policy unless it overrides it.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
void main() {
  runApp(
    ProviderScope(
      retry: (retryCount, error) => null,
      child: const MyApp(),
    ),
  );
}
```

In pure Dart, or anywhere you build a container by hand, the same parameter lives on `ProviderContainer`:

```dart
// Dart 3.x, riverpod 3.x
final container = ProviderContainer(
  retry: (retryCount, error) => null,
);
```

### Turn it off for one provider

Global-off is a blunt instrument. Usually you want retry for the two network providers where it helps and off for the provider that parses local config and can only fail because of a bug. Every provider constructor takes its own `retry` parameter, and a per-provider value wins over the scope-level one.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final configProvider = FutureProvider<AppConfig>(
  (ref) async => AppConfig.fromAsset(await rootBundle.loadString('config.json')),
  retry: (retryCount, error) => null, // parsing bugs won't fix themselves
);
```

The same parameter exists on the class-based providers. For a `NotifierProvider` or `AsyncNotifierProvider`, it sits next to the constructor tear-off:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final todoListProvider = NotifierProvider<TodoList, List<Todo>>(
  TodoList.new,
  retry: (retryCount, error) => null,
);
```

### Turn it off in code-generated providers

If you use `riverpod_generator`, the annotation carries a `retry` argument. Point it at a named function so the generated provider picks it up.

```dart
// Flutter 3.44, Dart 3.x, riverpod_annotation 3.x
Duration? noRetry(int retryCount, Object error) => null;

@Riverpod(retry: noRetry)
Future<int> counter(Ref ref) async {
  throw StateError('fails once, stays failed');
}
```

Run `dart run build_runner build` after changing the annotation. The generated `counterProvider` now carries the no-retry policy, and you never touch the generated file.

## What the default already skips

Before you disable retry globally, know that the default is not as aggressive as "retry everything ten times." Two categories are excluded out of the box.

`Error` (as opposed to `Exception`) is never retried. In Dart, `Error` signals a programming mistake: a failed assertion, a null-check on a null, a bad cast. These are not recoverable by waiting, so Riverpod surfaces them immediately. If your provider throws `StateError` or `TypeError`, the default retry does not kick in at all. The `brokenProvider` above throws `StateError`, which is an `Error` subtype, so on a strict reading it would surface immediately; swap it for a plain `Exception` if you want to watch the full ten-attempt storm in the console.

`ProviderException` is also skipped. When provider A reads provider B and B has failed, Riverpod wraps B's failure in a `ProviderException` before it reaches A. Retrying A would be pointless because A itself is fine; it is B that needs to recover. The default retry recognizes this wrapper and does not retry it, which avoids a cascade where every provider in a dependency chain runs its own retry schedule. If you have ever wondered why the wrapping type matters, it is the same `ProviderException` behind the broken `try`/`catch` when [Riverpod 3.0 throws ProviderException instead of your original error](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/).

So "disable retry" in practice means "stop retrying recoverable `Exception`s." Errors and dependency failures were already surfacing immediately.

## Bounding retry instead of killing it

Disabling retry is the right call for providers that load local data, parse assets, or perform any operation where failure means a bug rather than a hiccup. But for genuinely flaky I/O, a bounded retry is better than none. The pattern is: cap the attempts low, skip errors you know are permanent, and keep a short backoff.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? networkRetry(int retryCount, Object error) {
  // Give up after 3 tries.
  if (retryCount >= 3) return null;
  // A 404 will not become a 200 by waiting.
  if (error is NotFoundException) return null;
  // Otherwise back off: 300ms, 600ms, 1.2s.
  return Duration(milliseconds: 300 * (1 << retryCount));
}

final userProvider = FutureProvider<User>(
  (ref) => api.fetchUser(),
  retry: networkRetry,
);
```

Three attempts over about two seconds is usually enough to ride out a transient failure without making the user stare at a spinner for 13 seconds. The default of 10 attempts is tuned for resilience over responsiveness; most apps want the opposite trade for user-facing providers.

## Disable retry in every test

This is the change most teams forget, and it produces the most confusing symptom: a test that used to assert on an error state now times out. A `ProviderContainer` created the normal way inherits the default retry, so a provider you *want* to fail spends 13 seconds retrying before your `expect` on the error ever runs.

Riverpod 3.0 ships `ProviderContainer.test`, a constructor that adds automatic disposal for tests, and you should pass it a no-op retry.

```dart
// Dart 3.x, riverpod 3.x, flutter_test
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  test('brokenProvider surfaces its error immediately', () async {
    final container = ProviderContainer.test(
      retry: (retryCount, error) => null,
    );

    await expectLater(
      container.read(brokenProvider.future),
      throwsA(isA<StateError>()),
    );
  });
}
```

Without the `retry` override this test would eventually pass, but only after the full retry schedule, which either blows your test timeout or makes the suite crawl. Set the no-op retry in a shared test helper so every container gets it by default and no one has to remember.

## The gotcha with side effects in build

The reason retry is worth understanding rather than blindly disabling is that provider `build` methods are not supposed to have externally visible side effects, but in practice they often do. If your `build` logs to analytics, increments a metric, or writes to a cache before it throws, every retry repeats that side effect. Ten attempts means ten analytics events for a single logical failure. Bounding retry to a low count, or disabling it on providers whose `build` is not idempotent, keeps your telemetry honest. If you are reaching for state after an `await` inside these methods, the same discipline that keeps you [checking Ref.mounted after an async gap](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) applies to retry-heavy providers, because a retry runs the whole async body again.

One more subtlety: retry counts reset when the provider is invalidated and rebuilt from scratch. The 10-attempt budget is per continuous failure streak, not per app session. A provider that fails, exhausts its retries, gets invalidated by a pull-to-refresh, and fails again starts a fresh 10-attempt budget. If you rely on the retry to eventually stop, make sure invalidation is not silently resetting it.

## Choosing your default

For a new Riverpod 3.0 app, the pragmatic setup is: keep a short bounded retry at the `ProviderScope` level for the common case, and override individual providers to `null` where retry cannot help. That gives you resilience on network reads without the 13-second spinner on deterministic failures.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) {
    if (retryCount >= 2) return null; // app-wide default: 3 attempts max
    return Duration(milliseconds: 300 * (1 << retryCount));
  },
  child: const MyApp(),
)
```

If you are coming from Riverpod 2.x and want the old "fail once, stay failed" behaviour everywhere while you evaluate the feature, the global `retry: (_, __) => null` is the honest starting point. Turn it back on per provider once you know which ones actually benefit. The migration notes cover the rest of what changed alongside retry in the [Riverpod 2.x to 3.0 upgrade](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), and if you are still deciding whether Riverpod is the right tool at all, the [Provider vs Riverpod vs Bloc comparison](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) puts this in context. For the loading and error rendering side of the same providers, see how to [show loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Sources

- [Automatic retry](https://riverpod.dev/docs/concepts2/retry) - Riverpod documentation on the retry callback signature, defaults, and per-provider configuration.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) - the retry feature announcement and default backoff behaviour.
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) - migration guidance including `ProviderContainer.test`.
- [riverpod changelog](https://pub.dev/packages/riverpod/changelog) - version history for the 3.x line.
