---
title: "Migrate from Riverpod 2.x to Riverpod 3.0 in Flutter"
description: "A step-by-step upgrade from flutter_riverpod 2.x to 3.x: bump the packages, move StateProvider and friends to the legacy import, drop the AutoDispose and Family ref types, handle ProviderException wrapping and automatic retry, and fix the == notification filtering that silently drops StreamProvider events. Tested on Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
---

Upgrading a real app from `flutter_riverpod` 2.x to 3.x is usually a half-day job, and most of it is mechanical find-and-replace. The 3.0 line shipped in September 2025 and the current release is 3.3.2 (June 2026); this guide is tested on that version with Flutter 3.44 (stable, May 2026) and Dart 3.x. What actually breaks: `StateProvider`, `StateNotifierProvider`, and `ChangeNotifierProvider` move behind a `legacy.dart` import, every `Ref` subtype (`FutureProviderRef`, `AutoDisposeNotifier`, `FamilyNotifier`) collapses into one type, provider errors now come out wrapped in a `ProviderException`, and providers now filter notifications with `==`. The last two are the ones that cause runtime surprises rather than compile errors, so read those sections carefully. If your codebase already uses code-generation (`@riverpod`), you have less to change than if you hand-wrote provider declarations.

## Why upgrade at all

Riverpod 2.x still works, so the case for moving has to be concrete:

- **Automatic retry** with exponential backoff is built in. A `FutureProvider` that fails on a flaky network no longer stays failed until you manually `ref.invalidate` it.
- **`Ref.mounted`** replaces the hand-rolled "is this provider still alive after the await" mixin that every non-trivial app used to carry. See [checking Ref.mounted after an async gap](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) for the full pattern.
- **One unified `Ref` type** and one `Notifier` per shape. No more `AutoDisposeFamilyAsyncNotifier` type names that read like a compiler stress test.
- **Offline persistence** and **mutations** land as experimental APIs, so form-submission state and cache-across-restart stop being something you build by hand.

## What breaks

| Area                        | Change                                                                              | Severity |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Legacy providers            | `StateProvider`, `StateNotifierProvider`, `ChangeNotifierProvider` need `legacy.dart` | high     |
| Ref subtypes                | `FutureProviderRef`, `StreamProviderRef`, etc. all become a single `Ref`            | high     |
| AutoDispose / Family types  | `AutoDisposeNotifier`, `FamilyNotifier` removed; use modifiers on `Notifier`        | high     |
| Error propagation           | Reads rethrow `ProviderException` wrapping your original error                       | high     |
| Notification filtering      | All providers use `==` to decide whether to notify listeners                        | medium   |
| Automatic retry             | Failed providers retry by default with backoff                                      | medium   |
| `ProviderObserver`          | Callbacks take a single `ProviderObserverContext`                                   | medium   |
| `AsyncValue.valueOrNull`    | Renamed to `value`; the old throwing `value` getter is gone                         | low      |

## Pre-flight checklist

Before you touch a single provider:

1. Commit or stash everything. This migration touches a lot of files and you want a clean `git diff` to review.
2. Confirm your Dart SDK is 3.x. Riverpod 3.0 requires it. Run `dart --version` and check.
3. If you use code-generation, make sure `build_runner` runs cleanly on the current 2.x code first. You do not want to debug generator errors and migration errors at the same time.
4. Note whether you use `riverpod_lint`. It ships lint rules and a `dart fix` migration helper that automates several of the steps below, so having it installed saves manual edits.

## Step 1: Bump the packages

Update every Riverpod package in `pubspec.yaml` to the 3.x line in one go. Mixing a 2.x and a 3.x package will not resolve.

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

Then resolve:

```bash
# Flutter 3.44
flutter pub get
```

**Verify:** `flutter pub deps | grep riverpod` shows every Riverpod package on a 3.x version. If pub complains about a version conflict, a transitive dependency is still pinning `riverpod` 2.x; run `flutter pub deps` to find the culprit.

## Step 2: Run the automated fixes first

Riverpod 3.0 ships `dart fix` migration rules through `riverpod_lint`. Run them before doing anything by hand, because they handle the tedious mechanical rewrites (the `Ref` subtype renames, the `AutoDispose` prefix removal) across every file at once.

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**Verify:** re-run `dart fix --dry-run` and confirm the Riverpod-specific fixes are gone from the list. Then `git diff` and read what it changed. The tool is good but not omniscient, so the remaining steps are the parts it cannot infer.

## Step 3: Move legacy providers behind the legacy import

`StateProvider`, `StateNotifierProvider`, and `ChangeNotifierProvider` still exist, but they now live in a separate library so the main import surface only exposes the modern API. If you import them from the main package, you get an "undefined name" error.

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

This is a deliberate nudge, not a deprecation warning you can ignore forever. The long-term move is to rewrite each `StateProvider` as a `Notifier` and each `StateNotifierProvider` as a `Notifier` or `AsyncNotifier`, the same target shape you would land on when [migrating from the provider package](/2026/06/migrate-from-provider-to-riverpod-in-flutter/). But you do not have to do that rewrite during the version bump. Add the import, get green, and convert later.

**Verify:** the app compiles. Grep for `legacy.dart` and confirm every file that uses a legacy provider has the import, and no file imports it without needing it (the linter will flag the unused import).

## Step 4: Collapse the Ref subtypes and Notifier variants

In 2.x, a code-generated provider handed you a typed ref like `CounterRef`, and hand-written providers used `FutureProviderRef<T>`, `StreamProviderRef<T>`, and so on. In 3.0 there is a single `Ref`. The `dart fix` pass usually handles this, but hand-written declarations that the tool skipped need editing.

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

The same unification hits the class-based notifiers. `AutoDisposeNotifier`, `FamilyNotifier`, and the combinatorial explosion of names in between are gone. You express the same behaviour with modifiers on the base `Notifier`:

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

Family parameters that used to live in `FamilyNotifier` now arrive as regular `build` arguments (code-gen) or through the `.family` modifier (manual). If you use `@riverpod`, the generator handles the wiring and you only rerun it.

**Verify (code-gen users):** delete the generated files and rebuild.

```bash
dart run build_runner build --delete-conflicting-outputs
```

Confirm zero generator errors and that the regenerated `.g.dart` files reference `Ref`, not the old typed refs.

## Step 5: Handle ProviderException wrapping

This is the change most likely to slip past a compile check and break at runtime. In 3.0, when a provider's `build` throws and another piece of code reads it imperatively, the read does not rethrow your original exception. It rethrows a `ProviderException` that wraps it. Any `on MyException catch` block that was catching the original type stops firing.

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

The unwrapped path is `AsyncValue`. When you render a provider with `.when(error: ...)` or pattern-match an `AsyncError`, the error you get there is your original exception, not the wrapper. So UI code that reads state reactively is unaffected; only imperative `ref.read(...future)` inside a `try`/`catch` needs the change. The dedicated write-up on [Riverpod 3.0's ProviderException](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) covers the corner cases.

**Verify:** grep for `ref.read(` combined with `.future` inside `try` blocks, and for any `catch` clause that names a domain exception. Add a test that makes a provider throw and asserts your handler still runs.

## Step 6: Fix the == notification filtering

In 2.x, different provider types had different rules for deciding when to notify listeners. In 3.0 they all use `==`. For `Notifier` state this is usually fine, but it bites hard with `StreamProvider` and `StreamNotifier`: if your stream emits objects that are equal by `==` (for example, mutable classes that do not override equality, or two values that happen to compare equal), the second emission is now dropped as a duplicate.

The failure mode is a UI that stops updating even though the stream is clearly emitting. The fix is to make sure the emitted type has correct equality semantics. If you emit domain objects, give them value equality (a `record`, a Freezed class, or a hand-written `==`/`hashCode`). See [Dart records vs Freezed classes](/2026/05/dart-records-vs-freezed-classes/) for which to reach for.

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

If you genuinely need every emission through regardless of equality, override `updateShouldNotify` on a `StreamNotifier` to return `true`.

**Verify:** run the app, watch any stream-backed widget, and confirm it still updates on every emission you expect. This one has no compile signal, so it needs a manual smoke test.

## Step 7: Decide on automatic retry

Failed providers now retry automatically: a 200 ms initial delay that doubles up to 6.4 seconds. For most network-backed providers this is an upgrade. But if you have a provider whose failure is permanent (a validation error, a 404 that will never become a 200), the silent retries waste calls and can mask the error in the UI for several seconds.

Opt out globally at the scope, or per provider:

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**Verify:** point a provider at an endpoint that returns a 404 and confirm it does not hammer the server, or that your retry predicate short-circuits as intended.

## Step 8: Update ProviderObserver and the valueOrNull rename

If you have a custom `ProviderObserver` (analytics, logging), its callbacks changed signature. The container and provider arguments merged into a single `ProviderObserverContext`.

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

And the small one: `AsyncValue.valueOrNull` is renamed to `value`. The old `value` getter (which threw on loading/error) is gone. If you relied on the throwing behaviour, pattern-match the `AsyncData` case instead.

**Verify:** the analyzer flags every `valueOrNull` call site; the `dart fix` pass from Step 2 usually rewrites them, but confirm none remain.

## Verification: the full smoke test

After all steps, run the checklist end to end:

- `flutter pub get` resolves with every Riverpod package on 3.x.
- `dart run build_runner build --delete-conflicting-outputs` produces zero errors (code-gen users).
- `flutter analyze` is clean, no leftover `AutoDispose`/`valueOrNull`/typed-ref references.
- `flutter test` passes, including the new tests you added for `ProviderException` handling and stream emission.
- Manually exercise: a stream-backed screen, an error screen, and a screen that triggers a provider failure, to confirm retry, wrapping, and `==` filtering all behave.

## Rollback plan

This migration is a one-way door in practice. The moment you write `import 'package:flutter_riverpod/legacy.dart'` and adopt the single `Ref` type, reverting means undoing every file. The clean rollback is `git`, not code: do the whole migration on a branch, keep the 2.x branch untouched, and only merge once the smoke test passes. Do not do a half-migration and ship it; a codebase with some files on 3.x semantics and some on 2.x assumptions (especially around error wrapping) is worse than either version alone.

## Gotchas we hit

- **The `==` filtering is invisible until it isn't.** A `StreamProvider<List<Item>>` backed by a list that the same code mutates in place will emit the same list instance twice, and 3.0 drops the second notification. Emit a fresh list (or a value-equal type) every time.
- **`ref.read(provider.future)` in a `catch` is the sneaky one.** It compiles fine and only reveals itself when the provider actually errors in production. Search for it proactively.
- **`dart fix` does not touch string-typed or dynamically-built provider references.** Anything the analyzer cannot see statically, you edit by hand.
- **Do not upgrade `riverpod` without upgrading `riverpod_generator` in lockstep.** A 3.x runtime with a 2.x generator produces code that references the old `Ref` subtypes and fails to compile in confusing ways.

## Related

- [Migrate from provider to Riverpod in Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [How to check Ref.mounted after an async gap in Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Fix: Riverpod 3.0 throws ProviderException instead of the original error](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Migrate from FutureBuilder to a Riverpod AsyncNotifier in Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Sources

- [Migrating from 2.0 to 3.0, Riverpod docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, Riverpod docs](https://riverpod.dev/docs/whats_new)
- [riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
