---
title: "Migrate from FutureBuilder to a Riverpod AsyncNotifier in Flutter (flutter_riverpod 3.3.2)"
description: "A step-by-step migration from an inline FutureBuilder widget to a Riverpod AsyncNotifier in a real Flutter app: move the async work out of build, expose it as a provider, render with .when() or switch pattern matching, and add refresh and mutation methods. Tested on Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-06-18
updatedDate: 2026-06-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
---

Moving a screen from `FutureBuilder` to a Riverpod `AsyncNotifier` is usually a 30-to-60 minute job per screen, and most of that time is spent deleting code rather than writing it. What breaks: the Future you used to create inside `build` moves into a provider, the widget loses its `StatefulWidget` boilerplate, and any manual `setState` retry logic gets replaced by `ref.invalidate`. It is worth doing the moment a second widget needs the same data, you want caching across navigation, or you need to trigger a refresh from somewhere other than the widget that owns the `FutureBuilder`. If a screen genuinely owns a one-shot Future that nothing else touches, leave it as a `FutureBuilder` -- this migration buys you nothing there.

This guide uses Flutter 3.44, Dart 3.x, and `flutter_riverpod` 3.3.2. The code-generation snippets assume `riverpod_annotation` 3.x and `riverpod_generator` 3.x with `build_runner`.

## Why move off FutureBuilder

- **The Future stops being recreated on every rebuild.** A `FutureBuilder` whose `future:` is built inline re-runs its async work each time the parent rebuilds. An `AsyncNotifier` builds once and caches the result until you invalidate it. (If you are staying on `FutureBuilder` for now, the fix for that specific bug is covered in [keeping FutureBuilder from recreating its Future](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)
- **The data becomes shareable.** Two widgets watching the same provider hit the cache, not two separate network calls.
- **Refresh and mutation get a real home.** Pull-to-refresh, retry-on-error, and optimistic updates become methods on the notifier instead of `setState` gymnastics in the widget.
- **Errors are typed, not swallowed.** `AsyncValue` carries `loading`, `data`, and `error` (with stack trace) as first-class states you pattern-match on.

## What breaks

| Area | Before (`FutureBuilder`) | After (`AsyncNotifier`) | Severity |
| --- | --- | --- | --- |
| Where the Future lives | Created in `build` or `initState` | `build()` method of the notifier | high |
| Widget type | Usually `StatefulWidget` | `ConsumerWidget` (stateless) | medium |
| Loading/error rendering | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` or `switch` | medium |
| Retry | Rebuild + recreate Future | `ref.invalidate(provider)` | low |
| Mutations | `setState` after `await` | method + `AsyncValue.guard` | medium |
| Cancellation on dispose | Manual `mounted` checks | Automatic via `ref.onDispose` | low |

The one genuinely high-severity item is where the Future lives: everything else follows from moving it.

## Pre-flight checklist

- `flutter --version` reports 3.44 or later, Dart 3.x.
- `flutter_riverpod: ^3.3.2` is in `pubspec.yaml`. If you want code generation, also add `riverpod_annotation: ^3.0.0`, and under `dev_dependencies` add `riverpod_generator: ^3.0.0` and `build_runner`.
- Your app is wrapped in a `ProviderScope` at the root. If it is not, that is step zero:

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- Pick one widget to migrate first. Do not convert the whole app in one commit. Smoke-test each screen as you go.

## The starting point: an inline FutureBuilder

Here is the pattern we are migrating away from. A profile screen fetches a user and renders three states by hand. The bug baked into it is the classic one: `repo.fetchUser(userId)` runs again on every rebuild because the Future is created inside `build`.

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## Migration steps

1. **Declare the provider.** Move the async call into a notifier. There are two ways to write it; pick one and stay consistent across the codebase.

**Code-generation style (recommended for new code):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

The `userId` parameter on `build` makes this a family: `profileControllerProvider(userId)` gives you one cached notifier per id. Run the generator and verify it produces the `.g.dart` file with no errors:

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**Manual style (no code generation):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Both produce a provider whose value is an `AsyncValue<User>`. The notifier's `build` runs once per `userId` and the result is cached until invalidated. Note that you no longer construct `UserRepository()` by hand: inject it through another provider so it is testable and shared.

2. **Convert the widget to a `ConsumerWidget`.** The `StatefulWidget`/`StatelessWidget` becomes a `ConsumerWidget`, and `build` gains a `WidgetRef`. Read the provider with `ref.watch`, then render the `AsyncValue`.

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

Verify: hot-restart the screen. It should fetch exactly once. Navigate away and back -- it should not refetch (the cache is alive as long as something keeps the provider mounted). That single-fetch behaviour is the whole point of the migration.

3. **Render with switch pattern matching (optional but cleaner).** Dart 3 pattern matching reads better than `.when()` for some teams and lets you keep stale data visible during a refresh. The full treatment of these patterns lives in [showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), but the short version:

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

Verify: this compiles with no `non-exhaustive switch` warning. The `_` catch-all handles `AsyncLoading`.

4. **Replace retry with `ref.invalidate`.** The old retry path recreated the Future by rebuilding. Now retry is one line. Add a button to the error branch:

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` discards the cached value and re-runs `build`, which flips the `AsyncValue` back to `loading` and then to `data` or `error`. Verify: force an error (turn off the network), tap Retry with the network back on, confirm it transitions loading then data.

5. **Add mutations with `AsyncValue.guard`.** This is the capability `FutureBuilder` never had. To update the user and reflect the result, add a method to the notifier. `AsyncValue.guard` wraps the async call so a thrown exception becomes an `AsyncError` instead of an unhandled crash.

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

Call it from the widget with `ref.read(...).rename(...)` inside a callback (use `read`, not `watch`, in callbacks). Verify: trigger a rename, watch the UI go loading then show the new name; trigger a failing rename and confirm the error state renders instead of throwing.

## Verification

Run this checklist after migrating a screen:

- `flutter analyze` reports no new warnings, and if you used codegen, `dart run build_runner build` completes clean.
- The screen fetches exactly once on first open (add a print in the repository or watch the network tab).
- Navigating away and back does not refetch unless you invalidate.
- The error branch renders for a forced failure and Retry recovers.
- `flutter test` passes. Providers are trivially testable: override `userRepositoryProvider` with a fake in a `ProviderContainer` and assert on the `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## Rollback plan

This migration is reversible per screen because you can convert one widget at a time. To roll back a single screen, restore the `FutureBuilder` widget and delete its provider; nothing else depends on it if you migrated incrementally. The only one-way door is removing the old `StatefulWidget` plumbing across many screens in a single commit -- do not do that. Keep each screen's migration in its own commit so a revert is a one-line `git revert`.

## Gotchas we hit

**`ref.watch` inside callbacks rebuilds nothing useful.** In an `onPressed` handler use `ref.read`. `watch` is for `build`; using it in a callback subscribes at the wrong time and is a common source of "my button does not refresh the screen" confusion.

**The family parameter must be stable.** `profileControllerProvider(userId)` keys the cache on `userId`. If you accidentally pass a freshly constructed object (a new `User` instance, a map) instead of a value-equal key, you get a fresh notifier every rebuild and the cache never hits. Use primitives or types with proper `==`.

**Disposed `ref` after an await.** If a mutation awaits and the provider is disposed mid-flight (the user navigated away), touching `ref` afterwards throws. Riverpod 3 surfaces this clearly; the fix and the exact message are in [fixing "Cannot use ref after the widget was disposed"](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Guard with `ref.mounted` if you must touch `ref` after an await in a long mutation.

**Provider gets disposed too eagerly.** By default a provider with no listeners is disposed. If you navigate away and back and see a refetch you did not want, that is auto-dispose doing its job. Keep it alive deliberately with `ref.keepAlive()` inside `build`, or accept the refetch as correct cache behaviour.

**Do not mix this with `provider` package state.** If your app still uses the legacy `provider` package elsewhere, migrate that separately; the two coexist but blur the mental model. The [provider to Riverpod migration](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) covers that path. And if you are still deciding whether `AsyncNotifier` is even the right call for a given widget, the [FutureBuilder vs Riverpod AsyncValue decision guide](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) draws the line.

## Sources

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- official Riverpod migration guide for the unified `Ref` and notifier changes.
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- the canonical `AsyncNotifier` and `build()` contract.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- the 3.0 feature and breaking-change list.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- version 3.3.2 confirmation.
