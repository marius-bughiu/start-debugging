---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: which package do I actually need?"
description: "Install flutter_riverpod for almost every Flutter app. Use riverpod only for Dart-only code, and hooks_riverpod only if you already use flutter_hooks."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
---

If pub.dev is showing you `riverpod`, `flutter_riverpod`, and `hooks_riverpod` and you cannot tell which one to add, the answer for almost every Flutter app is `flutter_riverpod`. Add `riverpod` (no `flutter_` prefix) only when you are writing pure Dart with no Flutter dependency, such as a CLI or a server. Add `hooks_riverpod` only if you already use the `flutter_hooks` package and want `HookConsumerWidget`. These three are not competing state managers: they are layers of the same library, and picking the wrong one just means a slightly wrong import, not a different architecture. All versions here target Riverpod 3.3.2 (the 3.0 line shipped 2025-09-10), Flutter 3.44, and Dart 3.12.

## These are layers, not rivals

The confusion comes from pub.dev listing them side by side as if they were alternatives like Provider and Bloc. They are not. `riverpod` is the core engine, written in plain Dart with zero Flutter imports. `flutter_riverpod` takes that engine and adds the Flutter glue: `ProviderScope`, `ConsumerWidget`, `Consumer`, and the `WidgetRef` you call `ref.watch` on. `hooks_riverpod` takes `flutter_riverpod` and adds one more thing on top: integration with the separate `flutter_hooks` package, exposing `HookConsumerWidget`.

Each package re-exports the one below it. When you add `flutter_riverpod`, you also get everything from `riverpod` without listing it. When you add `hooks_riverpod`, you get everything from `flutter_riverpod` too. That is why you never install more than one of them at a time, and why installing `flutter_riverpod` and then importing from `package:riverpod/riverpod.dart` is a mistake that produces confusing duplicate-symbol errors.

## Feature matrix

| Feature | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Depends on Flutter | No | Yes | Yes |
| Provider engine (`Provider`, `Notifier`, `ref.watch`) | Yes | Yes | Yes |
| `ProviderScope` widget | No | Yes | Yes |
| `ConsumerWidget` / `Consumer` | No | Yes | Yes |
| `HookConsumerWidget` / `HookConsumer` | No | No | Yes |
| Requires `flutter_hooks` alongside | No | No | Yes |
| Re-exports the package below | -- | `riverpod` | `flutter_riverpod` |
| Right for | Dart-only code | Most Flutter apps | Flutter apps already using hooks |

The `AsyncValue` type, `ref.listen`, provider modifiers like `.autoDispose`, and the automatic-retry behavior added in 3.0 all live in the core `riverpod` package, so every row that has them is identical across the three. The only real differences are the widget base classes and the Flutter dependency.

## When to install flutter_riverpod

This is the default, and it covers the large majority of apps.

- You are building a normal Flutter application (mobile, desktop, or web) and want `ProviderScope` at the root and `ConsumerWidget` in your screens.
- You do not use, and do not plan to use, the `flutter_hooks` package.
- You want the smallest dependency surface that still gives you the full Flutter integration.

Installation is one command:

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

A minimal working widget looks like this:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`, `ConsumerWidget`, and `WidgetRef` are all provided by `flutter_riverpod`. The `NotifierProvider`, `Notifier`, and `state` come from the core engine that `flutter_riverpod` re-exports. You never import `package:riverpod/riverpod.dart` directly in a Flutter app.

## When to install plain riverpod

Reach for the bare `riverpod` package only when there is no Flutter in the project at all.

- A Dart command-line tool that shares provider-based logic with a Flutter app.
- A `dart_frog` or `shelf` server that wants Riverpod's dependency graph on the backend.
- A pure-Dart package that other apps depend on, where pulling in Flutter would be wrong.

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

In a Dart-only context there is no widget tree, so instead of `ProviderScope` you construct a `ProviderContainer` yourself and read from it:

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

If your project has a `pubspec.yaml` with `flutter:` under dependencies, this is almost never the package you want. Adding plain `riverpod` to a Flutter app and then wondering why `ConsumerWidget` and `ProviderScope` do not resolve is one of the most common Riverpod setup mistakes.

## When to install hooks_riverpod

Install `hooks_riverpod` only when you are already committed to `flutter_hooks` and want to use hooks inside the same widget that reads providers.

The key fact: `flutter_hooks` and Riverpod are two independent packages. `flutter_hooks` is a port of React's hooks that manages local widget state, things like a `TextEditingController` or an `AnimationController` scoped to one widget. Riverpod manages shared application state. They solve different problems, and you can use either without the other. `hooks_riverpod` exists purely so a single widget can do both without a class-inheritance conflict.

That conflict is real. `HookWidget` (from `flutter_hooks`) and `ConsumerWidget` (from `flutter_riverpod`) are both base classes, and a Dart class can only extend one superclass. You cannot write `class X extends HookWidget, ConsumerWidget`. `hooks_riverpod` resolves this by shipping `HookConsumerWidget`, a single base class that is both at once:

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

Two things to note. First, `hooks_riverpod` does not bundle `flutter_hooks`, so you must add both:

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

Second, because `hooks_riverpod` re-exports `flutter_riverpod`, you do not, and should not, also list `flutter_riverpod` in `pubspec.yaml`. The single `hooks_riverpod` import gives you `ProviderScope`, `ConsumerWidget`, and `HookConsumerWidget` all together. A file that only reads providers can still extend the plain `ConsumerWidget`; you reach for `HookConsumerWidget` only in the specific files that also call hooks.

The official docs are blunt about this for beginners: if you are new to Riverpod, do not start with hooks. They add a second mental model on top of an already unfamiliar one. Learn `flutter_riverpod` first, and adopt `hooks_riverpod` later only if you find yourself wanting hooks for local state. If you are managing controllers by hand today, the disposal discipline in [disposing Flutter controllers to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) is exactly the boilerplate that hooks aim to remove, which is the honest case for adopting them.

## Does the annotation package replace the runtime package?

A frequent follow-up: if I add `riverpod_annotation` for the `@riverpod` codegen, do I still need `flutter_riverpod`? Yes. The annotation package only supplies the `@riverpod` marker and the types the generator emits against. It contains no runtime: no `ProviderScope`, no `Notifier`, no `ref`. Your app still runs on one of the three runtime packages, and the generated code imports from it. So a codegen Flutter app depends on both `flutter_riverpod` (runtime) and `riverpod_annotation` (annotations), not one instead of the other.

The same "one runtime package" rule holds in tests. A widget test that pumps a `ProviderScope` uses `flutter_riverpod` (via `flutter_test`), while a pure-Dart unit test that spins up a `ProviderContainer` uses plain `riverpod`. You do not add a separate testing package for Riverpod; the `ProviderContainer` and `overrides` you need for tests already ship inside the runtime package you installed.

## The gotcha that actually trips people: the codegen packages version differently

Here is the part that surprises even experienced Riverpod users in the 3.x era. The runtime packages (`riverpod`, `flutter_riverpod`, `hooks_riverpod`) are on the 3.3.x line, but the code-generation packages are on a different major version entirely:

| Package | Role | Version (2026-07) |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | codegen annotations | 4.0.3 |
| `riverpod_generator` | codegen (dev) | 4.0.4 |
| `riverpod_lint` | lint rules (dev) | 3.x |

If you use the `@riverpod` annotation to generate providers, you install four packages, not one. `riverpod_annotation` is a normal dependency; `riverpod_generator` and `build_runner` are dev dependencies:

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

Then generate with:

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

Do not try to pin `riverpod_annotation` to `^3.0.0` to match the runtime. The 4.x annotation line is the one that matches the 3.3.x runtime; the version numbers are deliberately decoupled because the generator evolves on its own cadence. Let `flutter pub add` resolve the constraints and do not hand-edit them to "line up," because they are not supposed to line up. This is the single most common `pub get` failure in a fresh Riverpod 3 project.

Code generation is optional. Everything in this article works without it. The annotation approach mainly saves you from writing the provider-type boilerplate (`NotifierProvider<Counter, int>`) by hand, and it is a good default for new projects, but it is a separate decision from which runtime package you install.

## What to actually type

Strip away the explanation and the decision is short:

- Building a Flutter app, no hooks: `flutter pub add flutter_riverpod`. This is you, 90% of the time.
- Pure Dart, no Flutter: `dart pub add riverpod`.
- Flutter app that already uses `flutter_hooks`: `flutter pub add hooks_riverpod flutter_hooks`.
- Using the `@riverpod` annotation on top of any of the above: add `riverpod_annotation` plus the `riverpod_generator` and `build_runner` dev dependencies, and let the resolver pick the 4.x line.

Whichever runtime package you pick, the providers, the `Notifier` API, and `AsyncValue` behave identically, because they all come from the same core engine. You are only choosing how much Flutter glue and hook support to layer on top. Once that is settled, the real learning is in the API itself: how [Riverpod's AsyncValue compares to FutureBuilder and StreamBuilder](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/), how to [check ref.mounted after an async gap](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), and how the new [automatic provider retry in 3.0](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) changes error handling. If you are still deciding whether to use Riverpod at all, the [Provider vs Riverpod vs Bloc comparison](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) makes that call; if you are moving off the old line, the [Riverpod 2.x to 3.0 migration guide](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) covers the breaking changes.

## Sources

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- official install commands for `riverpod`, `flutter_riverpod`, `hooks_riverpod`, and the codegen packages.
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- the relationship between `flutter_hooks`, `flutter_riverpod`, and `HookConsumerWidget`, and the advice for newcomers.
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- confirms the 4.x codegen line paired with the 3.3.x runtime.
- [flutter_hooks on pub.dev](https://pub.dev/packages/flutter_hooks) -- the independent hooks package that `hooks_riverpod` integrates with.
