---
title: "Provider vs Riverpod vs Bloc for Flutter state management in 2026"
description: "Pick Riverpod for most new Flutter apps in 2026. Choose Bloc for large teams that want an enforced event-driven structure, and keep Provider only for legacy code."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
---

If you are starting a new Flutter app in 2026 and cannot decide between Provider, Riverpod, and Bloc, the short answer is Riverpod. With Riverpod 3.3.1 (the 3.0 line shipped 2025-09-10) it is compile-safe, testable without a `BuildContext`, and the code-generation path removes almost all of the boilerplate that used to be the main argument against it. Reach for Bloc (`flutter_bloc` 9.1.1) when you have a large team that benefits from a strict, event-driven contract and a traceable state history. Keep Provider (6.1.5) only if you already have it in a codebase or you are teaching someone the underlying `InheritedWidget` model. All examples here target Flutter 3.44 and Dart 3.12.

## The three packages are not the same kind of tool

Before comparing them, it helps to see that these libraries solve overlapping but different problems.

Provider is a thin, well-made wrapper over Flutter's own `InheritedWidget`. It does dependency injection and rebuild propagation, and that is mostly it. The state class is usually a `ChangeNotifier` you write by hand. It is the package the official Flutter documentation reached for when it needed a teaching example, which is why so many tutorials use it.

Riverpod is what the author of Provider built next, specifically to fix Provider's structural problems: the runtime `ProviderNotFoundException`, the dependence on widget position in the tree, and the inability to read state from plain Dart. Riverpod providers live outside the widget tree, so they are reachable from anywhere and resolved at compile time.

Bloc is a pattern first and a package second. It pushes you to model every change as an explicit event that flows into a component and produces a new immutable state. That ceremony is the point: on a big team, an enforced `Event -> Bloc -> State` pipeline makes behavior predictable and reviewable.

## Feature matrix

| Feature | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| Mental model | `InheritedWidget` + `ChangeNotifier` | Providers outside the tree | Event-driven, immutable states |
| Compile-time safety | No (runtime lookup) | Yes | Yes |
| Needs `BuildContext` to read | Yes | No | No (via `context.read` or direct) |
| Boilerplate | Low | Low with codegen | High |
| Testability | Needs widget pumping | Pure Dart, no widget tree | Pure Dart, `bloc_test` helpers |
| Async / loading state | Manual | `AsyncValue`, built in | Manual states or `emit` |
| Auto retry on failure | No | Yes (since 3.0) | No |
| State traceability | Weak | Medium | Strong (every transition observable) |
| Learning curve | Gentle | Moderate | Steep |
| Best fit | Legacy, tutorials | Most new apps | Large teams, complex flows |

The single most important row is "compile-time safety." A misconfigured Provider throws `ProviderNotFoundException` at runtime, often only on the screen where it is missing. Riverpod and Bloc both surface that class of mistake before the app runs.

## The same counter in all three

A counter is small enough to compare the ergonomics directly. Watch how much code each one needs and where the state lives.

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Note the dependency on `context`. If `CounterPage` is rendered without a `ChangeNotifierProvider` above it, `context.watch<CounterModel>()` throws at runtime.

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

The `counterProvider` is generated and globally reachable. There is no tree position to get wrong, and `ref` is resolved at compile time. Wrap the app once in `ProviderScope` and you are done.

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc is the most verbose for a counter, and that comparison is unfair to it: the value of Bloc shows up when there are twenty events and ten states, not one. The `Increment` event is a record in your app's history. With a `BlocObserver` attached you can log every transition, which is exactly what you want when debugging a complex screen.

## When to pick Riverpod

- **A new app in 2026 with no legacy constraints.** This is the default. Riverpod gives you compile-time safety, testing without `pumpWidget`, and async handling through `AsyncValue` out of the box. See our walkthrough of [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) for how clean async gets.
- **You read state outside widgets.** Background sync, a repository layer, or a service that needs the current auth token can call `ref.read` without a `BuildContext`. Provider cannot do this cleanly.
- **You want resilience for flaky network providers.** Riverpod 3.0 added automatic retry with exponential backoff (200ms doubling up to 6.4s) for providers that fail during initialization, plus automatic pause of listeners when a widget scrolls offscreen.
- **You are migrating off GetX or similar.** Riverpod is the usual destination. Our [GetX to Riverpod migration guide](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) covers the moving parts.

One caveat: in Riverpod 3.0, `StateProvider`, `StateNotifierProvider`, and `ChangeNotifierProvider` moved to `package:riverpod/legacy.dart`. New code should use the `Notifier` and `AsyncNotifier` classes shown above, ideally with code generation via `@riverpod`.

## When to pick Bloc

- **A large team that wants an enforced contract.** When five engineers touch the same feature, the rigid `Event -> Bloc -> State` flow stops everyone inventing their own pattern. The structure is the deliverable.
- **You need an auditable state history.** A `BlocObserver` sees every transition. For flows like checkout, onboarding, or a multi-step form, replaying the exact sequence of events that produced a bug is worth the boilerplate.
- **Complex, branching async logic.** Bloc's event transformers (debounce, throttle, `droppable`, `concurrent`) give you fine control over how overlapping events are handled. That is harder to express in the other two.
- **You want `Cubit` for the simple cases.** Not every screen needs full events. A `Cubit` is a Bloc without the event layer: you call methods that `emit` new state directly, so you can mix lightweight Cubits and full Blocs in the same app.

## When to pick Provider

- **You already have it.** A working Provider app does not need a rewrite. There is nothing wrong with `ChangeNotifier` for app state that is not performance-critical.
- **You are teaching the fundamentals.** Provider maps almost one to one onto `InheritedWidget`, so it is the clearest way to show someone how Flutter propagates state without a third-party abstraction.
- **A genuinely tiny app.** A single settings screen with one toggle does not justify code generation or an event pipeline.

What Provider should not be in 2026 is the default for a fresh, non-trivial app. The runtime lookup model is the exact problem Riverpod was built to remove.

## The gotchas that pick for you

A few constraints override personal preference.

**Reading state from non-widget code.** If your architecture has a service or repository layer that must read app state directly, Provider is effectively out. It needs a `BuildContext`. Riverpod and Bloc both let you read state from plain Dart, which usually settles the decision on its own.

**Team size and review culture.** On a solo project or a small team, Bloc's ceremony is friction with little payoff, and Riverpod wins on speed. On a 15-person team where consistency across features matters more than lines of code, Bloc's rigidity is a feature, not a cost.

**Immutable state discipline.** Bloc and modern Riverpod both push you toward immutable state objects. If your team is comfortable with sealed classes and value equality (see [Dart records vs Freezed classes](/2026/05/dart-records-vs-freezed-classes/) for the modeling options), both fit. If you have a large codebase built on mutable `ChangeNotifier` objects, the cheapest path may be to stay on Provider until a feature actually needs more.

**Existing async patterns.** Riverpod's `AsyncValue` is the least-effort way to render loading, data, and error from one source of truth. If your screens are mostly async data fetches, that alone is a strong reason to choose it.

## The recommendation, restated

For most new Flutter apps in 2026, use Riverpod 3.3.1 with code generation. You get compile-time safety, context-free reads, first-class async, and the 3.0 resilience features, at a boilerplate cost that codegen brings close to Provider's.

Choose Bloc 9.1.1 when an enforced, event-driven structure and a fully traceable state history are worth more to your team than terseness, which is most often true on large teams and complex flows. Use Cubits within a Bloc app for the screens that do not need full events.

Keep Provider 6.1.5 for legacy apps, teaching, and trivial screens, but do not reach for it as the default on a new, non-trivial project. The deciding question is rarely "which has the nicest counter," it is "do I read state outside widgets, how big is my team, and how much async do I have." Answer those three and the choice usually makes itself. If you are weighing Flutter against other stacks entirely, our [Flutter vs React Native vs MAUI comparison](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) zooms out one level. And whichever you pick, remember to [dispose your controllers](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), because no state management library will clean those up for you.

## Sources

- [Riverpod: What's new in 3.0](https://riverpod.dev/docs/whats_new) - legacy APIs, automatic retry, pause/resume, offline persistence, mutations.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) and [changelog](https://pub.dev/packages/flutter_riverpod/changelog) - version 3.3.1, 3.0.0 released 2025-09-10.
- [flutter_bloc on pub.dev](https://pub.dev/packages/flutter_bloc) - version 9.1.1, BlocProvider / BlocBuilder / BlocListener, Cubit vs Bloc.
- [provider on pub.dev](https://pub.dev/packages/provider) - version 6.1.5, ChangeNotifierProvider, Flutter Favorite.
- [Flutter release notes](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 stable, Dart 3.12.
