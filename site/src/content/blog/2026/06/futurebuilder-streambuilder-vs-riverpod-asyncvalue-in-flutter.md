---
title: "FutureBuilder/StreamBuilder vs Riverpod AsyncValue in Flutter: which should you use?"
description: "Use FutureBuilder or StreamBuilder for a self-contained, throwaway async widget. Reach for Riverpod AsyncValue once the result is shared, cached, or mutated. Here is the decision, the gotchas, and runnable code for both. Tested on Flutter 3.44 and flutter_riverpod 3.3.1."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "futurebuilder"
---

If you are deciding between Flutter's built-in `FutureBuilder` / `StreamBuilder` and Riverpod's `AsyncValue`, the short answer is: keep the builders for a single, self-contained widget that owns a throwaway async result, and move to Riverpod `AsyncValue` the moment that result is shared across screens, cached, refreshed, or mutated. The builders are not "the beginner version" of the same thing. They are a UI primitive that subscribes to one async object. `AsyncValue` is a state model that lives outside the widget tree. This guide is tested on Flutter 3.44 (stable, 2026-05-18), Dart 3.12, and `flutter_riverpod` 3.3.1 (the 3.0 line shipped 2025-09-10).

## They solve overlapping problems at different layers

`FutureBuilder` and `StreamBuilder` are widgets. You hand each one a `Future` or `Stream`, and it gives your `builder` callback an `AsyncSnapshot<T>` describing the current connection state (waiting, active, done) plus the latest data or error. The widget subscribes when it is inserted, unsubscribes when it is removed, and re-subscribes if you pass it a different `Future`/`Stream` instance. That is the entire contract. There is no caching, no sharing, and no memory of the result once the widget leaves the tree.

Riverpod's `AsyncValue<T>` is not a widget at all. It is a sealed union with three subtypes (`AsyncData`, `AsyncLoading`, `AsyncError`) that a provider exposes as its value. The async work runs inside a provider that lives outside the widget tree, so any widget can read it, several widgets can read the same instance, and the result survives rebuilds and navigation. You render it with `value.when(...)` or a Dart 3 `switch`, the same way you render an `AsyncSnapshot`, but the source of truth is a provider rather than a widget field.

So the real question is not "which renders three states better." Both render three states fine. The question is where the async result should live and how many things need to see it.

## Feature matrix

| Concern | FutureBuilder / StreamBuilder (Flutter 3.44) | Riverpod AsyncValue (flutter_riverpod 3.3.1) |
| --- | --- | --- |
| What it is | A widget that subscribes to one Future/Stream | A sealed state type exposed by a provider |
| Where the result lives | In the widget, dies when the widget unmounts | In a provider, outside the tree, survives navigation |
| Sharing across screens | No, each builder re-runs its own work | Yes, one provider read from many widgets |
| Caching / dedup | None, you memoize the Future yourself | Built in, provider caches until invalidated |
| Trigger on every rebuild | Yes, if the Future is created in `build` | No, provider `build` runs once until invalidated |
| Loading + previous data | Manual, snapshot drops `data` while waiting | `value.isLoading` keeps `value` during refresh |
| Mutations / refresh | Reassign the Future and `setState` | `ref.invalidate` or `AsyncValue.guard` in a notifier |
| Testing without a widget | Hard, needs `pumpWidget` | Easy, read the provider in a plain `ProviderContainer` |
| Dependencies | Zero, ships with the SDK | `flutter_riverpod` package |
| Lines of boilerplate for a one-off | Minimal | More setup for a single throwaway call |

## When FutureBuilder or StreamBuilder is the right call

Reach for the built-in builders when the async result genuinely belongs to one widget and nobody else needs it.

- **A self-contained leaf widget.** A dialog that loads one record, a tile that resolves an image dimension, a settings row that reads a single preference. The work starts when the widget appears and is irrelevant once it is gone. Wrapping that in a provider is ceremony with no payoff.
- **A stream you already own and want to render directly.** If you hold a `Stream` from a plugin (a `Geolocator` position stream, a `connectivity_plus` status stream) and you only display it in one place, `StreamBuilder` is the most direct path. Flutter 3.44's `StreamBuilder` handles the subscribe/unsubscribe lifecycle for you.
- **Zero added dependencies.** A small app, a code sample, a package example, or a screen in a codebase that has deliberately avoided a state-management library. The builders are part of the SDK, so there is nothing to add.
- **You are teaching or prototyping.** The builders make the async-to-UI mapping visible in one place. That clarity is worth a lot when the goal is to understand the lifecycle rather than ship a feature.

Here is the correct shape. The `Future` is created once in `initState`, not in `build`, so the widget does not re-fetch on every parent rebuild.

```dart
// Flutter 3.44, Dart 3.12
class UserCard extends StatefulWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  State<UserCard> createState() => _UserCardState();
}

class _UserCardState extends State<UserCard> {
  late Future<User> _user;

  @override
  void initState() {
    super.initState();
    _user = api.fetchUser(widget.id); // created ONCE, not in build
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _user,
      builder: (context, snapshot) {
        return switch (snapshot) {
          AsyncSnapshot(connectionState: ConnectionState.waiting) =>
            const CircularProgressIndicator(),
          AsyncSnapshot(hasError: true, :final error) =>
            Text('Failed: $error'),
          AsyncSnapshot(hasData: true, :final data?) =>
            Text(data.name),
          _ => const SizedBox.shrink(),
        };
      },
    );
  }
}
```

The single most common bug with this widget is creating the `Future` inline, like `future: api.fetchUser(widget.id)` directly in `build`. Every rebuild then allocates a new `Future`, `FutureBuilder` sees a new identity, and it restarts from the loading state. That failure mode is common enough to have its own write-up: see [why FutureBuilder recreates its Future on every rebuild](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) for the full repro and every variant that triggers it.

## When Riverpod AsyncValue is the right call

Move to `AsyncValue` when the async result stops being a private detail of one widget.

- **The result is shared.** Two screens show the same user profile, or a header and a body both read the current cart. With builders, each subscriber re-runs the fetch. With a provider, the work runs once and both widgets read the same `AsyncValue`.
- **You need caching and dedup.** Riverpod caches a provider's value until something invalidates it. Navigate away and back, and the data is still there instead of flashing a spinner. The 3.0 line even adds `AsyncValue.isFromCache`, so the UI can tell server data apart from offline-persisted data.
- **You mutate and refresh.** A pull-to-refresh, an optimistic update, a retry. `ref.invalidate(provider)` re-runs the load, and during that reload `value.isLoading` is `true` while `value.hasValue` stays `true`, so you keep showing the old data instead of blanking the screen. Doing that with `FutureBuilder` means juggling a stored `Future`, a `setState`, and your own "keep previous data" logic.
- **You want to test without pumping a widget.** A provider's logic can be exercised in a plain `ProviderContainer` with no `WidgetTester`, no `pumpWidget`, and no fake `BuildContext`.

The same three-state render, now sourced from a provider:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.1
final userProvider = FutureProvider.family<User, String>((ref, id) {
  return api.fetchUser(id); // runs once, cached per id, shared everywhere
});

class UserCard extends ConsumerWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(id));
    return switch (user) {
      AsyncData(:final value) => Text(value.name),
      AsyncError(:final error) => Text('Failed: $error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Two widgets calling `ref.watch(userProvider('42'))` share one fetch and one cached result. There is no `initState`, no stored field, and no "create the Future once" discipline to remember, because the provider already runs its `build` exactly once per argument until it is invalidated. For the full set of states, mutations with `AsyncValue.guard`, and keeping previous data on refresh, see [how to show loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## The rebuild and re-fetch behaviour that actually decides it

Performance is not the axis here. Both approaches render at the same frame rate. What differs is how many times your async work runs, and that is a correctness and cost issue, not a raw-speed one.

Put a counter inside the async call and watch what happens when the surrounding widget rebuilds (a theme toggle, a keyboard opening, a parent `setState`):

- **Future created in `build` with FutureBuilder**: the fetch fires on every rebuild. A screen that rebuilds ten times during a scroll makes ten network calls. This is the default mistake, not an edge case.
- **Future hoisted to `initState` with FutureBuilder**: the fetch fires once per widget instance. Navigate away and back, the widget is rebuilt from scratch, and it fetches again because the old `State` is gone.
- **FutureProvider with AsyncValue**: the fetch fires once per provider argument and is cached. Rebuilds do not re-run it. Navigating away and back reads the cache. It only re-runs when you invalidate it or its dependencies change.

If your async work is a cheap local read, none of this matters and the builder wins on simplicity. If it is a network call, a database query, or anything with a cost or a rate limit, the caching is the whole reason `AsyncValue` exists, and hand-rolling the same behaviour around `FutureBuilder` reimplements a worse version of Riverpod's provider cache.

## The gotcha that picks for you

A few constraints settle the decision regardless of taste.

**You are already using Riverpod.** If the app has providers, do not mix `FutureBuilder` into a screen that reads them. Reading a provider's data and then wrapping a second `FutureBuilder` around a different async call gives you two unrelated lifecycles on one screen and two places where "loading" can be true. Expose the second call as a provider too and render both with `AsyncValue`. Consistency here prevents the class of bug where one half of the screen is stale.

**The result must outlive the widget.** Anything fetched in `initState` dies with the `State`. If the user navigates forward and back and you do not want a fresh spinner and a fresh network call every time, you need a cache that lives above the widget. That is a provider. `FutureBuilder` cannot give you cross-route persistence no matter how you arrange it.

**You touch `ref` after an await.** This is a Riverpod-specific trap, not a reason to avoid it: if you `await` inside a notifier and then read `ref` after the widget that triggered it is gone, you hit `Cannot use "ref" after the widget was disposed`. The fix is to capture what you need before the await. It is worth knowing before you commit, and it is covered in [the fix for using ref after disposal](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

**You explicitly want zero dependencies.** A pub package example, a reproduction case, or a team policy against state-management libraries forces the builders. That is a legitimate constraint, and the builders are perfectly capable for self-contained async UI.

## StreamBuilder has one extra wrinkle

Everything above applies to `Future` work. Streams add a subscription lifecycle, and that tilts the decision a little further toward Riverpod for anything non-trivial. `StreamBuilder` resubscribes when you pass it a new `Stream` instance and unsubscribes when it leaves the tree, but it does not multicast: two `StreamBuilder`s on the same single-subscription stream will throw, because a single-subscription `Stream` allows only one listener. Riverpod's `StreamProvider` sits in front of the stream, so multiple widgets read one `AsyncValue` without fighting over the subscription, and the latest value is cached for late subscribers. If a stream is displayed in exactly one place, `StreamBuilder` is fine. If more than one widget needs it, `StreamProvider` removes the single-listener problem entirely.

## The recommendation, with the full context behind it

Default to Riverpod `AsyncValue` for any async result that is shared, cached, refreshed, or mutated, which in a real app is most of them. You get one fetch instead of N, free caching across navigation, `isLoading` that preserves previous data on refresh, and logic you can test without a widget. Keep `FutureBuilder` and `StreamBuilder` for genuinely self-contained, throwaway async UI: a leaf widget that loads one thing, shows it, and forgets it when it unmounts, especially in apps that carry no state-management dependency. The builders are not training wheels you outgrow. They are the right tool when the async result has an audience of one, and the wrong tool the moment it has an audience of two. Pick by ownership, not by familiarity.

If you are still choosing a state-management approach more broadly, the trade-offs between packages are in [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/). And if your async UI keeps surfacing failures, [how to handle network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) covers turning thrown exceptions into a clean error state in both models.

## Sources

- [FutureBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
- [AsyncValue class, flutter_riverpod API docs](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [riverpod changelog on pub.dev](https://pub.dev/packages/riverpod/changelog)
