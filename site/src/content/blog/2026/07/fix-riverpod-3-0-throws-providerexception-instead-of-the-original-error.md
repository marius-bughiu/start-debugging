---
title: "Fix: Riverpod 3.0 throws ProviderException instead of the original error"
description: "Riverpod 3.0 wraps errors thrown while reading a provider in a ProviderException. Catch that type and read e.exception to get your original error back, or use AsyncValue.error which is unwrapped."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
---

Your `on NotFoundException catch` stopped firing after the Riverpod 3.0 upgrade because reading a failed provider no longer rethrows your original exception. It rethrows a `ProviderException` that wraps it. To fix a broken `try`/`catch`, catch `ProviderException` and inspect `e.exception` for your real error, or switch to `AsyncValue.error`, which is deliberately left unwrapped. This is tested on `flutter_riverpod` 3.x (the 3.0 line shipped September 2025; the current release is 3.3.2, June 2026), Flutter 3.44, and Dart 3.x.

The upgrade did not introduce a new failure. Your provider still throws the same exception it always did. What changed is the type that comes back out the other side when another piece of code reads that provider imperatively.

## The error in context

You have a provider whose `build` throws a domain exception, and a caller that reads it inside a `try`/`catch`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

On Riverpod 2.x this caught `NotFoundException` directly. On 3.0 the `on NotFoundException` clause is skipped, and if you have no broader `catch`, the exception propagates uncaught. If you log the actual runtime type you see:

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

The `NotFoundException` is still in there. It is now a passenger inside `ProviderException` rather than the thing being thrown.

## Why Riverpod 3.0 wraps the error

A provider can be in an error state for two very different reasons, and Riverpod 2.x could not tell them apart at the point you caught the error.

The first reason: **this provider failed**. Its own `build` threw. The second reason: **this provider is fine, but a provider it depends on failed**, and the error propagated down the graph. In a dependency chain like `dashboardProvider` watching `userProvider` watching `authProvider`, an exception in `authProvider` surfaces at every downstream read. If all three rethrew the raw `AuthException`, a `catch` around `dashboardProvider` could not distinguish "the dashboard itself broke" from "something three levels up broke and I am seeing the echo."

Riverpod 3.0 solves this by wrapping. When you read a provider whose value could not be computed, the error is boxed in a `ProviderException` that records **which provider** threw and carries the original error plus its stack trace. The wrapper is the signal that you are looking at a propagated provider failure, and the `.exception` property is the escape hatch back to your real error. This is the behavior described in the [Riverpod 3.0 migration guide](https://riverpod.dev/docs/3.0_migration) and tracked in [riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320).

There is a small piece of history here worth knowing. Early Riverpod (pre-2.0) also wrapped in `ProviderException`, then `2.0.0-dev.1` removed the wrapping and switched to rethrowing the raw exception, and `3.0.0-dev.16` brought the wrapper back deliberately. If you remember `ProviderException` disappearing years ago, you are not misremembering; 3.0 reintroduced it on purpose.

## Minimal repro

Two files. A provider that throws, and a widget that reads it imperatively.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

Run `load` when the user is missing. On 3.0 the `on NotFoundException` clause does not match because the thrown object is a `ProviderException`, not a `NotFoundException`.

## The fix, in detail

Pick the approach that matches how you are consuming the provider. In order of preference:

### 1. Catch ProviderException and switch on e.exception

If you must read the provider imperatively (inside an event handler, a mutation, a `ref.read` in a callback), catch the wrapper and pull the original error out of `.exception`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` is the original object you threw, so a Dart pattern `switch` on it reads cleanly and lets you bind fields (`:final id`) in the same line. Always keep a `default: rethrow` so an unexpected error is not silently eaten; a bare `on ProviderException catch` with no rethrow will swallow every future error type you forget to enumerate.

If you prefer `is` checks over patterns, the equivalent is:

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. Read the error through AsyncValue, which is not wrapped

This is the better fix when the code is in a widget, because it is also the idiomatic Riverpod shape. `AsyncValue.error` carries your **original** exception, not the wrapper. The wrapping only happens on the imperative rethrow path (`ref.read`/`ref.watch` throwing); the reactive `AsyncValue` you get from watching a provider is untouched:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Note `error is NotFoundException` matches directly. No unwrapping, because `AsyncValue.error` never held a `ProviderException` in the first place. If you are rendering loading and error UI anyway, prefer this over an imperative `try`/`catch`; the same pattern underpins [showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 3. Handle the error in ref.listen's onError, also unwrapped

For side effects (a snackbar, a navigation, analytics) driven by a provider failing, `ref.listen`'s `onError` callback receives the raw error too:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## Which APIs wrap and which do not

The single most useful table to keep in your head. The wrapper appears only when a provider **rethrows** into your code imperatively.

Wrapped in `ProviderException` (read `.exception`):

- `ref.read(p.future)` where `p` failed to build.
- `ref.watch(p)` on a synchronous provider that threw, when the read rethrows.
- `await container.read(p.future)` in tests.

Not wrapped (you get the original error directly):

- `AsyncValue.error` from `ref.watch(asyncProvider)`. Check `value.error is MyException`.
- `ref.listen(p, ..., onError: (e, s) => ...)`. The `e` is raw.
- `ProviderObserver.providerDidFail` (and the observer hooks generally). Observers see the unaltered error and stack.

If your handling lives in a widget's build via `AsyncValue`, or in a listener, or in an observer, you likely do not need to change anything. The migration pain is concentrated in imperative `try`/`catch` around `ref.read(...future)`.

## Gotchas and version traps

**You cannot import ProviderException on some early 3.0 builds.** [Issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) documents a window where the docs described the wrapping but a build threw a `StateError` and `ProviderException` was not exported yet. If `on ProviderException` will not compile, or you are catching `StateError` instead, you are on an affected pre-release. Upgrade to a current stable (`flutter_riverpod` 3.3.2 or later) where the type is exported and the behavior matches the docs. Do not write a permanent `on StateError` catch to work around it; that will break again when you update.

**Do not double-wrap in your own error mapping.** If you have an interceptor that catches everything and re-throws a normalized `AppException`, make sure it unwraps `ProviderException` first, otherwise you nest a `ProviderException` inside your `AppException` inside another `ProviderException` on the next read. Unwrap at the boundary: `final real = e is ProviderException ? e.exception : e;`.

**Retry ignores the wrapper.** Riverpod 3.0's automatic retry (exponential backoff, 200ms doubling to a 6.4s cap) retries genuine provider build failures but does not retry a `ProviderException` that merely propagated from a dependency, which prevents a failing leaf provider from triggering a retry storm across every downstream provider. You do not configure this; just know that a caught-and-rethrown `ProviderException` is treated as "already accounted for."

**The wrapper is not an async-gap guard.** Catching `ProviderException` handles the provider *failing*; it does nothing about the provider being *disposed* mid-await. Those are separate crashes. If you also see `UnmountedRefException` after an await, that is the [ref.mounted problem](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), not this one, and it needs a `if (!ref.mounted) return;` guard rather than a catch.

**`rethrow` inside `on ProviderException` rethrows the wrapper, not the inner error.** If your `default` branch does `rethrow`, the caller up the stack still sees a `ProviderException`. That is usually what you want (the provenance is preserved), but if an outer layer expects raw domain exceptions, rethrow the inner one explicitly: `Error.throwWithStackTrace(e.exception, e.stackTrace)`.

## Where this fits in a 2.x to 3.0 upgrade

This is one line item on the larger 3.0 migration, alongside the `Ref.mounted` lifecycle change and the move to unified `Notifier` classes. If you are doing the upgrade now, grep your codebase for `ref.read(` calls wrapped in `try` with a typed `on SomeException catch`, and for `.future` reads inside `catch` blocks. Those are the call sites that silently stopped matching. Widget code that renders `AsyncValue` is safe. For the broader picture of why Notifier-owned lifecycle and error semantics are the modern default, see [Provider vs Riverpod vs Bloc in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), and if you are still on the older `provider` package, the [provider to Riverpod migration](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) covers the move before you hit any of this.

The mental model that keeps it straight: a `ProviderException` means "a provider in the graph failed and you read it imperatively." Reach into `.exception` for the real cause, or, better, consume the failure reactively through `AsyncValue` where no wrapping happens at all. The same discipline that keeps [network errors handled gracefully](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) applies here: decide, per call site, whether you are reacting to a value or reacting to a thrown failure, and pick the API that hands you the error in the shape you expect.

## Related

- [How to check Ref.mounted after an async gap in Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) is the other Riverpod 3.0 error that surfaces only after the upgrade, on the async-gap path rather than the throw path.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) is the reactive alternative to imperative try/catch, and it is not affected by the wrapping.
- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) is a different Riverpod crash people conflate with this one.
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) covers why Riverpod's error and lifecycle model is the current default.
- [Migrate from provider to Riverpod in Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) is the step before this if you are still on the legacy package.

## Sources

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- the official statement that provider read failures are rethrown as `ProviderException` and the `e.exception` catch pattern.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- the wrapping rationale (distinguishing a provider failing from depending on a failed provider), plus the retry behavior that ignores `ProviderException`.
- [rrousselGit/riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) -- the early-3.0 discrepancy where a `StateError` was thrown and `ProviderException` could not be imported.
- [riverpod package changelog](https://pub.dev/packages/riverpod/changelog) -- the history: `2.0.0-dev.1` removed the wrapper, `3.0.0-dev.16` reintroduced it; current stable 3.3.2 (June 2026).
