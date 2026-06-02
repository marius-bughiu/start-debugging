---
title: "How to Show Loading and Error States with AsyncValue in Flutter Riverpod"
description: "Render loading, data, and error UI from a single AsyncValue in Riverpod 3. Use AsyncNotifier and AsyncValue.guard for mutations, .when() and switch pattern matching for the UI, keep previous data on refresh, and migrate the legacy StateNotifier pattern. Tested on flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
---

The short version: an async provider in Riverpod hands you an `AsyncValue<T>`, which is a single object that is always in exactly one of three states (data, loading, or error). You render all three from one place with `value.when(data: ..., loading: ..., error: ...)` or a Dart 3 `switch` over `AsyncData` / `AsyncLoading` / `AsyncError`. You produce those states from an `AsyncNotifier` whose `build` returns a `Future`, and you mutate them safely with `AsyncValue.guard`, which converts a thrown exception into an `AsyncError` instead of crashing. If you are on the older `StateNotifier`, the rendering side is identical once you expose an `AsyncValue` as state. This guide is tested on `flutter_riverpod` 3.x (the 3.0 line shipped in early 2026), Flutter 3.44, and Dart 3.x.

The reason this pattern matters is that almost every screen in a real app is async: it fetches something, the fetch can be in flight, and the fetch can fail. Teams that hand-roll this end up with three separate fields (`isLoading`, `data`, `errorMessage`), a tangle of `if` branches, and the classic bug where `isLoading` is `false` but `data` is still `null` because an early return forgot to flip a flag. `AsyncValue` makes the illegal states unrepresentable: there is no "loading and also has an error and also has data" because the type is a sealed union. You handle the three cases the compiler forces you to handle, and you are done.

## The three states, and why a union beats three booleans

`AsyncValue<T>` is a sealed class with three concrete subtypes:

- `AsyncData<T>` carries a `value` of type `T`.
- `AsyncLoading<T>` means a load is in progress.
- `AsyncError<T>` carries an `error` (`Object`) and a `stackTrace`.

Because the class is sealed, the analyzer knows the list of subtypes is closed, so a `switch` over them is exhaustive without a default case. That is the whole design: instead of reconstructing "which state am I in" from a bag of nullable fields on every rebuild, you pattern-match on a value whose type already encodes the answer.

It also has convenience getters you will reach for constantly:

- `isLoading`, `hasValue`, `hasError` are booleans.
- `value` is a nullable `T?` (it can be non-null even while `isLoading` is true, which matters for refresh, see below).
- `valueOrNull` is the safe accessor that never throws.
- `requireValue` returns the value or throws `AsyncValueIsLoadingException` / rethrows the error. Use it only when you have already proven you are in the data state.
- `isRefreshing` and `isReloading` distinguish a forced refresh from a dependency-driven recompute.

## A concrete screen: a list of articles that can load and fail

Here is the smallest realistic setup: a repository that fetches a list, a provider that exposes it, and a widget that renders all three states. I am using the code-generation flavor with `riverpod_annotation`, which is the recommended way to declare providers in the 3.x line.

```dart
// flutter_riverpod 3.x, riverpod_annotation 3.x, Dart 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'articles_provider.g.dart';

class Article {
  const Article(this.id, this.title);
  final String id;
  final String title;
}

@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll(); // may throw on a network failure
  }
}
```

The `build` method returns a `Future<List<Article>>`. Riverpod wraps that future for you: while it is pending, `ref.watch(articlesProvider)` is `AsyncLoading`; when it completes, `AsyncData`; if it throws, `AsyncError`. You never construct those states by hand for the initial load. You just return data or let an exception propagate.

If you are not using code generation, the manual form is the same class shape without the annotation:

```dart
// Manual (no code-gen) equivalent. flutter_riverpod 3.x
final articlesProvider =
    AsyncNotifierProvider<Articles, List<Article>>(Articles.new);

class Articles extends AsyncNotifier<List<Article>> {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll();
  }
}
```

## Rendering all three states with `.when()`

`.when()` is the most direct way to map an `AsyncValue` to widgets. It takes three required callbacks:

```dart
// flutter_riverpod 3.x
class ArticleListView extends ConsumerWidget {
  const ArticleListView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final articles = ref.watch(articlesProvider);

    return articles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => ListTile(title: Text(list[i].title)),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => ErrorView(
        message: _humanMessage(err),
        onRetry: () => ref.invalidate(articlesProvider),
      ),
    );
  }
}
```

Three things to notice. First, `ref.invalidate(articlesProvider)` is how the retry button re-runs `build`; it throws away the cached state and recomputes. `ref.refresh` does the same and returns the new value if you need it. Second, the `error` callback gets both the error object and its stack trace, so you can log the trace and show the user a friendly message: never put `err.toString()` straight on screen. Third, `_humanMessage` is where you translate exception types into copy, which dovetails with classifying the failure properly; see [how to handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) for the exception-to-message mapping that belongs there.

## The Dart 3 alternative: `switch` pattern matching

Because `AsyncValue` is sealed, you can pattern-match on it directly. Many teams prefer this in Riverpod 3 because it reads naturally and lets you destructure in one line:

```dart
// Dart 3.x switch expression over the sealed AsyncValue
Widget build(BuildContext context, WidgetRef ref) {
  final articles = ref.watch(articlesProvider);

  return switch (articles) {
    AsyncData(:final value) => ArticleList(items: value),
    AsyncError(:final error) => ErrorView(message: _humanMessage(error)),
    _ => const Center(child: CircularProgressIndicator()),
  };
}
```

The `_` arm catches `AsyncLoading`. Functionally this is equivalent to `.when()`, but it composes better when you want to add guards (for example `AsyncData(:final value) when value.isEmpty => const EmptyState()`). Use whichever your team finds more readable; they produce the same UI.

## Mutations: why you need `AsyncValue.guard`

The initial load is automatic, but a button that creates or deletes an article is a manual state transition, and that is where unguarded code crashes. The wrong way is to call the repository directly and let the exception escape into the widget tree. The right way sets the state to loading, runs the work inside `AsyncValue.guard`, and assigns the result:

```dart
// flutter_riverpod 3.x
@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() => ref.watch(articleRepositoryProvider).fetchAll();

  Future<void> add(String title) async {
    final repo = ref.read(articleRepositoryProvider);

    // Show loading while keeping the current list visible (see "refresh" below).
    state = const AsyncLoading<List<Article>>().copyWithPrevious(state);

    // guard converts a thrown exception into AsyncError instead of crashing.
    state = await AsyncValue.guard(() async {
      await repo.create(title);
      return repo.fetchAll();
    });
  }
}
```

`AsyncValue.guard` is the counterpart to the automatic wrapping in `build`. It runs your callback, returns `AsyncData` on success and `AsyncError` (with the captured stack trace) on failure, so a network blip during `add` flips the screen to your error UI instead of throwing an unhandled exception. The `copyWithPrevious(state)` call is what lets the list stay on screen during the mutation instead of flashing a full-screen spinner; the new `AsyncLoading` carries the old value, so `value` is still populated.

## Keeping data on screen during refresh

This is the detail that trips up everyone. When you `ref.refresh` an async provider, the state briefly returns to loading. If you naively show a spinner for every loading state, a pull-to-refresh blanks the whole screen for a frame. Riverpod 3 handles this with two flags on `.when()`:

- `skipLoadingOnRefresh` defaults to `true`. During a `ref.refresh` (an explicit, user-driven refresh), `.when()` keeps calling your `data` callback with the previous value instead of `loading`.
- `skipLoadingOnReload` defaults to `false`. When the provider reloads because a dependency changed, you get the `loading` callback by default.

So out of the box, a pull-to-refresh keeps the old list visible while the new one loads, which is what you want. If you instead want the spinner to appear on refresh, opt out:

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

For a pull-to-refresh control specifically, the idiomatic combination is to keep `skipLoadingOnRefresh: true` (so the list stays put) and drive `RefreshIndicator` from the returned future:

```dart
RefreshIndicator(
  onRefresh: () => ref.refresh(articlesProvider.future),
  child: articles.when(
    data: (list) => ListView(/* ... */),
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (err, _) => ErrorView(message: _humanMessage(err)),
  ),
);
```

Awaiting `articlesProvider.future` makes the spinner on the `RefreshIndicator` itself spin until the new data arrives, while the body keeps showing the old data underneath. That is the behavior users expect.

One caveat worth knowing: there is an [open issue](https://github.com/rrousselGit/riverpod/issues/4670) where `skipLoadingOnRefresh` and `skipLoadingOnReload` do not always behave as documented because a refresh can also trigger a reload. If your refresh unexpectedly flashes a spinner, that interaction is the first thing to check.

## Where the legacy `StateNotifier` fits

The search query that brings people here often pairs `AsyncValue` with `StateNotifier`, so it is worth being precise about the state of things in 2026. As of Riverpod 2.0, `Notifier` and `AsyncNotifier` replaced `StateNotifier`, and in Riverpod 3 the old `StateNotifier` and `StateNotifierProvider` types were moved out of the main barrel file into `package:flutter_riverpod/legacy.dart`. They still work, but they are no longer the recommended API.

If you have a `StateNotifier` that exposes async data, the trick that makes the rendering identical to everything above is to make its state an `AsyncValue` yourself:

```dart
// Legacy pattern. Import from the legacy barrel in flutter_riverpod 3.x.
import 'package:flutter_riverpod/legacy.dart';

class ArticlesNotifier extends StateNotifier<AsyncValue<List<Article>>> {
  ArticlesNotifier(this._repo) : super(const AsyncLoading()) {
    _load();
  }
  final ArticleRepository _repo;

  Future<void> _load() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(_repo.fetchAll);
  }
}

final articlesProvider =
    StateNotifierProvider<ArticlesNotifier, AsyncValue<List<Article>>>(
  (ref) => ArticlesNotifier(ref.watch(articleRepositoryProvider)),
);
```

Because `state` is an `AsyncValue<List<Article>>`, the widget code does not change at all: `ref.watch(articlesProvider).when(...)` works exactly as before. The lesson is that `AsyncValue` is the UI contract; `AsyncNotifier` versus `StateNotifier` is only about how you produce it. When you do migrate, `AsyncNotifier` removes the boilerplate (no manual constructor `_load`, no manual `AsyncLoading` in the constructor) because `build` does it for you. The official [migration guide from StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier) walks through the mechanical replacement, and the broader [how to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) guide covers the same `Notifier` / `AsyncNotifier` translation in the context of a full migration.

## Common gotchas

**Do not read `requireValue` in a loading state.** It throws `AsyncValueIsLoadingException`. Use it only inside the `data` branch or after checking `hasValue`. When you just want a fallback, use `valueOrNull ?? const []`.

**`isLoading` is true on refresh, not just initial load.** If you write `if (value.isLoading) return Spinner()` before checking `hasValue`, you will blank the screen on every refresh. Prefer `.when()` (which respects `skipLoadingOnRefresh`) or check `value.isLoading && !value.hasValue` to distinguish "first load" from "refreshing with data already present".

**An empty list is data, not loading.** A successful fetch that returns `[]` is `AsyncData([])`, so handle the empty case inside your `data` branch (an "Add your first article" view), not by treating empty as still-loading.

**Errors during mutation need `guard`, but errors in `build` do not.** Inside `build`, just `throw` (or let the repository throw); Riverpod captures it. Inside an imperative method like `add`, you must wrap with `AsyncValue.guard`, otherwise the exception escapes the notifier and becomes an unhandled error.

**Use a typed error model, not `toString()`.** Map exception types to user-facing copy in one helper. If your data model uses sealed classes or `Freezed`, the same exhaustiveness benefit you get from `AsyncValue` applies to your domain errors; see [Dart records vs Freezed classes](/2026/05/dart-records-vs-freezed-classes/) for when each is the right tool for modeling those.

## Testing the three states

Because the state is just a value, tests are straightforward: build a `ProviderContainer`, override the repository with a fake, and assert on the `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.x
test('emits AsyncError when the repository throws', () async {
  final container = ProviderContainer(overrides: [
    articleRepositoryProvider.overrideWithValue(ThrowingRepository()),
  ]);
  addTearDown(container.dispose);

  // Wait for the first build to settle.
  await container.read(articlesProvider.future).catchError((_) => <Article>[]);

  final state = container.read(articlesProvider);
  expect(state, isA<AsyncError>());
});
```

Override the repository to return data, an error, or a never-completing future, and you can assert every branch your UI renders. That is the practical payoff of pushing all three states into one typed value: the provider, the widget, and the test all speak the same language. When you are chasing why a state transition is janky rather than wrong, the frame timeline in DevTools tells you whether a rebuild is the cost; see [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) for reading that.

## Sources

- [AsyncValue class reference](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html), Riverpod API docs (`when`, `guard`, `requireValue`, `copyWithPrevious`).
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) and the [2.0 to 3.0 migration guide](https://riverpod.dev/docs/3.0_migration), riverpod.dev.
- [Migrating from StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier), riverpod.dev.
- [skipLoadingOnRefresh / skipLoadingOnReload behavior issue #4670](https://github.com/rrousselGit/riverpod/issues/4670), rrousselGit/riverpod.
