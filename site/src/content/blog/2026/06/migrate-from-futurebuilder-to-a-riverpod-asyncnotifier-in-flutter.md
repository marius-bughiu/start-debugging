---
title: "Migrate from FutureBuilder to a Riverpod AsyncNotifier in Flutter (flutter_riverpod 3.3.2)"
description: "Migrate FutureBuilder to Riverpod 3 AsyncNotifier with a verified manual family provider, explicit cache lifetime and retry behavior, and safe mutation handling."
pubDate: 2026-06-18
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
---

Move a `FutureBuilder` request into an `AsyncNotifier` when several widgets need the same state or you need a place for mutations. Migration is optional: a widget-owned, stored Future remains a good fit for `FutureBuilder`. Creating a new request in `build()` is the problem, not `FutureBuilder` itself.

This example uses the manual Riverpod 3 API with **flutter_riverpod 3.3.2**, checked on **Flutter 3.44.8 / Dart 3.12.2**. It does not use code generation. The two Dart blocks belong in the same file. Pin `flutter_riverpod: 3.3.2` to reproduce this verification; this is a tested version, not a claim that it is the newest release.

## Move the request and mutation into a provider

`UserRepository` is the application boundary. Implement it using your existing API client and override `userRepositoryProvider` inside the root `ProviderScope`. The default deliberately throws to make a missing implementation visible. For tests, override it with an in-memory fake.

In Riverpod 3, a manual family notifier extends `AsyncNotifier<User>`, receives the ID in its constructor, and has a parameterless `build()`. The old `FamilyAsyncNotifier<User, String>` is not the Riverpod 3 API. The provider below deliberately enables automatic disposal and disables automatic retries so the Retry button controls the example's recovery.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` converts a failed mutation to an error state. After the await, `ref.mounted` prevents writing into a disposed notifier. The loading guard avoids overlapping rename operations through this method; it is not a transaction or an HTTP cancellation mechanism.

## Render the shared state

Replace the existing screen with this `ConsumerWidget`. `ref.watch` subscribes during build; button callbacks use `ref.read` or `ref.invalidate`. The UI explicitly sets `skipLoadingOnRefresh: false` so an invalidation displays the loading branch even when previous data exists.

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## Decide how long the result should live

- Widgets using the same family key in the same provider scope share the active state. Keys need stable equality and `hashCode`.
- `.autoDispose` allows state to be destroyed after the last listener leaves. Returning to the screen after disposal fetches again. A dependency change or invalidation can also rerun `build()`: it is not guaranteed to execute once forever.
- Without code generation, automatic disposal is opt-in. Generated `@riverpod` providers enable it by default. These defaults must not be presented as equivalent. Use `ref.keepAlive()` or an explicit cache policy only when retention is intended.
- Riverpod 3 automatically retries eligible initialization failures by default. This example opts out with `retry: (_, _) => null`; choose an appropriate policy for your real application. `AsyncValue.guard` does not automatically retry mutation methods.
- `ref.onDispose` is a hook, not automatic request cancellation. Connect it to your HTTP client's cancellation/cleanup mechanism when needed.

A switch on `AsyncData` and `AsyncError` alone does not guarantee that stale data remains visible during refresh. Choose the rendering policy explicitly; `.when()` also has loading/refresh options. If you add a pull-to-refresh callback, await `ref.refresh(profileControllerProvider(userId).future)` so the gesture can finish with the request.

## Verify the migration

The corrected code passed analysis and provider/widget tests for shared reads, invalidation, disposal followed by refetch, failure and manual recovery, successful and failed rename, and mutation completion after disposal. These tests use a fake repository; they do not validate your network service or authentication. Run equivalent checks in your app:

```bash
flutter analyze
flutter test
```

Migrate one screen at a time. To roll back, restore its stored-Future implementation and remove the now-unused provider; avoid introducing a new Future on every build.

**Correction, 2 November 2026:** replaced the Riverpod 2 family API, made disposal/retry policies explicit, corrected navigation-cache and cancellation claims, and added the post-await lifecycle guard. The old version-2 provider guide is no longer presented as Riverpod 3 documentation.

## Sources and related reading

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
