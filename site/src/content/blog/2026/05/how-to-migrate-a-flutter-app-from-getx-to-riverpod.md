---
title: "How to migrate a Flutter app from GetX to Riverpod"
description: "Step-by-step migration from GetX to Riverpod 3.x in a real Flutter app: GetxController to Notifier, .obs to derived providers, Get.find to ref.watch, Get.to to go_router, plus snackbars, theming, and tests. Tested on Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "getx"
  - "state-management"
  - "migration"
  - "how-to"
---

The short version: install `flutter_riverpod` next to GetX, wrap your app in a `ProviderScope`, and migrate one screen at a time. Replace each `GetxController` with a `Notifier` (or `AsyncNotifier` for async work), translate every `.obs` field into either notifier state or a `Provider` that derives from it, swap `Get.find<T>()` for `ref.watch(myProvider)`, and move routing onto `go_router` so you can finally drop `Get.to`. Snackbars, dialogs, and theme changes get rebuilt against the regular Flutter APIs. Tested on Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1, riverpod_generator 2.6.5, and go_router 14.6.

GetX got popular because it answered every question with one import. State, routes, dependency injection, snackbars, internationalisation, theming, all from `package:get`. That was its strength in 2021 and has become its problem in 2026: a single dependency that owns half your runtime, a `BuildContext`-free shortcut culture (`Get.context!`, `Get.snackbar`) that makes the app hard to reason about, and a maintenance cadence that no longer matches Flutter's release pace. Riverpod is the opposite tradeoff. It does one thing (state graph with explicit dependencies) and forces you to lean on standard Flutter APIs for routing and UI shell. The migration is mostly mechanical, but a few patterns will fight back. This post walks through the ones that catch every team.

## What you are actually translating

Before you touch any code, write down what GetX is doing for you. Most apps lean on five things:

1. `GetxController` plus `Rx<T>` / `.obs` for state.
2. `Get.put` / `Get.lazyPut` / `Get.find` for dependency injection.
3. `Obx` and `GetBuilder` to rebuild widgets when state changes.
4. `Get.to`, `Get.toNamed`, `Get.back` for navigation.
5. `Get.snackbar`, `Get.dialog`, `Get.changeTheme` for UI side effects.

Riverpod handles 1-3 directly, with the right code-generated boilerplate. It does not do 4 or 5 by design. You will replace navigation with `go_router` (or the built-in `Navigator`), and snackbars / dialogs / theme changes go back to ordinary Flutter widgets reading state from a provider. This is the part of the migration that surprises people: Riverpod is smaller in scope than GetX, and that is the point.

## Add Riverpod without removing GetX

The gradual migration only works if both libraries can coexist. They can, with one caveat: `Get.put` keeps its own service locator, and Riverpod has its own provider tree, so a piece of state has exactly one owner at a time. Pick that owner per screen, not per type.

```yaml
# pubspec.yaml. Flutter 3.27.1, Dart 3.11.
dependencies:
  flutter:
    sdk: flutter
  get: ^4.7.2
  flutter_riverpod: ^3.3.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.2

dev_dependencies:
  build_runner: ^2.4.13
  riverpod_generator: ^2.6.5
  custom_lint: ^0.7.0
  riverpod_lint: ^2.6.5
```

Wrap your existing `GetMaterialApp` in a `ProviderScope`. You can keep `GetMaterialApp` until routing is migrated; the two trees do not fight.

```dart
// lib/main.dart, Flutter 3.27.1
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:get/get.dart';

void main() {
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'Migrating to Riverpod',
      home: const HomePage(),
      getPages: const [
        // existing GetX routes for screens not yet migrated
      ],
    );
  }
}
```

Add `riverpod_lint` to `analysis_options.yaml` once. It catches the two mistakes that bite hardest: reading a provider during build with `ref.read`, and forgetting to make a notifier `final` when you store it.

## GetxController to Notifier, the mechanical pass

Take the simplest controller you have. Counters are the GetX hello-world, and the conversion is almost line-for-line.

```dart
// Before: GetX 4.7, Flutter 3.27.1
import 'package:get/get.dart';

class CounterController extends GetxController {
  final RxInt count = 0.obs;
  final RxBool busy = false.obs;

  Future<void> incrementAfterDelay() async {
    busy.value = true;
    await Future.delayed(const Duration(milliseconds: 200));
    count.value++;
    busy.value = false;
  }
}
```

The Riverpod 3.x equivalent uses code generation. The generated `counterProvider` plays the role of `Get.put` plus `Obx`: it owns the state, knows how to rebuild dependents, and disposes itself when nothing reads from it.

```dart
// After: flutter_riverpod 3.3.1, riverpod_generator 2.6.5, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

class CounterState {
  const CounterState({this.count = 0, this.busy = false});

  final int count;
  final bool busy;

  CounterState copyWith({int? count, bool? busy}) =>
      CounterState(count: count ?? this.count, busy: busy ?? this.busy);
}

@riverpod
class Counter extends _$Counter {
  @override
  CounterState build() => const CounterState();

  Future<void> incrementAfterDelay() async {
    state = state.copyWith(busy: true);
    await Future.delayed(const Duration(milliseconds: 200));
    state = state.copyWith(count: state.count + 1, busy: false);
  }
}
```

Run `dart run build_runner watch -d` once and leave it running. The generator emits `counterProvider`, and your widget reads it the same way it used to read an `Obx`:

```dart
// flutter_riverpod 3.3.1
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(counterProvider);
    final ctrl = ref.read(counterProvider.notifier);
    return Scaffold(
      body: Center(
        child: s.busy
            ? const CircularProgressIndicator()
            : Text('${s.count}'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: ctrl.incrementAfterDelay,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Two things to internalise. First, `ref.watch` subscribes; `ref.read` does not. Use `ref.read` only inside callbacks (button taps, lifecycle methods), never in the build method. Second, the `state =` assignment does the equivalent of `count.value++` plus the rebuild, atomically. There is no longer a moment between `busy.value = true` and the rebuild where someone else can observe an inconsistent pair of fields. That single change kills a category of bug GetX apps tend to accumulate.

## Async work: AsyncNotifier replaces the manual loading flag

Most GetX controllers carry their own `isLoading.obs` because `RxFuture` has rough edges. Riverpod treats async as a first-class state with `AsyncValue<T>`. The same fetch-a-list-of-users pattern collapses to this:

```dart
// flutter_riverpod 3.3.1, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'users.g.dart';

@riverpod
class Users extends _$Users {
  @override
  Future<List<User>> build() async {
    final api = ref.watch(apiClientProvider);
    return api.fetchUsers();
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchUsers());
  }
}
```

The widget gets loading, error, and data states without a single boolean field:

```dart
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(usersProvider);
    return users.when(
      data: (list) => ListView(children: [for (final u in list) Text(u.name)]),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed: $e')),
    );
  }
}
```

Riverpod 3.0 also retries failed providers automatically by default. If you do not want that (a 401 should not retry, for example), set `retry: (count, error) => null` on the provider or globally on the `ProviderScope`. Read the [3.0 migration notes on retry](https://riverpod.dev/docs/3.0_migration) before flipping it; the default behaviour is genuinely useful but it can mask transient bugs in tests.

## Dependency injection: Get.find becomes ref.watch

GetX uses a global service locator. Anywhere in the app, `Get.find<ApiClient>()` returns the same instance. Riverpod replaces that with a provider that constructs the value once per `ProviderContainer`.

```dart
// flutter_riverpod 3.3.1
@riverpod
ApiClient apiClient(Ref ref) {
  final dio = ref.watch(dioProvider);
  return ApiClient(dio);
}

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  ref.onDispose(() => dio.close(force: true));
  return dio;
}
```

`ref.onDispose` is the part GetX never had a clean answer for. When the last consumer of `dioProvider` goes away, the HTTP client is closed; if it comes back, the provider rebuilds and you get a fresh `Dio`. The lifecycle is finally explicit. For services that genuinely live forever, mark the provider `keepAlive: true` (or skip `autoDispose`) and own that decision in code rather than hoping `Get.put(permanent: true)` survives a hot restart.

To keep both DI systems working during the migration, register a small bridge that hands GetX-resolved singletons to Riverpod consumers:

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

Drop the bridge as soon as the GetX side has nothing else to register.

## Reactive derivations: where .obs really shines, and how Riverpod replaces it

`.obs` makes derived state look free. `final fullName = ''.obs;` plus `ever(firstName, (_) => fullName.value = '$firstName $lastName')` is one line. The Riverpod equivalent is a separate provider that lists its inputs:

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

The advantage is that `fullNameProvider` is recomputed only when one of its inputs actually changes (Riverpod 3 uses `==` for equality filtering, an upgrade from the old `identical` check), and any widget reading it rebuilds only when the derived string changes. The cost is that you have to name every input. That naming is the migration's hardest editorial choice. Resist the temptation to bury everything in one mega-notifier; small providers compose better and they are far easier to test.

For derivations that need cancellation (a search box that hits the network as the user types), use an `AsyncNotifier` and cancel via `ref.onDispose` plus a `CancelToken`. That replaces GetX's `debounce(query, ..., time: ...)` with code that survives unit testing.

## Routing: drop Get.to and adopt go_router

This is the step teams put off the longest because GetX routing actually works. Pay the cost early. Once `go_router` owns navigation, the rest of the migration accelerates because you no longer need `Get.context` in the controllers.

```dart
// go_router 14.6.2, Flutter 3.27.1
final goRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomePage()),
      GoRoute(path: '/users/:id', builder: (_, s) => UserPage(id: s.pathParameters['id']!)),
    ],
    redirect: (ctx, state) {
      final auth = ProviderScope.containerOf(ctx).read(authProvider);
      if (!auth.isLoggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(goRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      theme: ref.watch(themeProvider),
    );
  }
}
```

Replace `Get.to(NextPage())` with `context.go('/next')`, `Get.toNamed('/users/42')` with `context.go('/users/42')`, and `Get.back()` with `context.pop()`. The string-typed paths feel like a downgrade from typed page constructors at first; in practice you write a thin `extension` on `BuildContext` that wraps the strings, and link checks come from `go_router_builder` or your tests.

## Snackbars, dialogs, themes: back to plain Flutter

`Get.snackbar` is convenient because it does not need a `BuildContext`. That convenience is also why you cannot test it. Riverpod's idiomatic answer is a state-only signal that the UI consumes:

```dart
// flutter_riverpod 3.3.1
@riverpod
class Toast extends _$Toast {
  @override
  String? build() => null;

  void show(String message) => state = message;
  void clear() => state = null;
}

class ToastListener extends ConsumerWidget {
  const ToastListener({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(toastProvider, (_, next) {
      if (next != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
        ref.read(toastProvider.notifier).clear();
      }
    });
    return child;
  }
}
```

Wrap the part of your tree that has a `Scaffold` ancestor in `ToastListener`. Now any controller can call `ref.read(toastProvider.notifier).show('Saved')` without touching `BuildContext`, and tests assert on the provider's state instead of intercepting an overlay.

Theming is similar. `Get.changeTheme` becomes a `themeProvider` that the `MaterialApp.router` watches. Localization can either keep using `Get.locale` until you migrate it last, or move to `flutter_localizations` plus a `localeProvider`.

## Tests get faster and clearer

The single biggest payoff is in tests. A GetX controller test usually needs `Get.testMode = true` plus careful teardown of singletons. A Riverpod test creates a `ProviderContainer`, overrides exactly the providers it cares about, and disposes at the end:

```dart
// flutter_test, flutter_riverpod 3.3.1
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('Counter increments after delay', () async {
    final container = ProviderContainer(overrides: const []);
    addTearDown(container.dispose);

    final notifier = container.read(counterProvider.notifier);
    expect(container.read(counterProvider).count, 0);

    final f = notifier.incrementAfterDelay();
    expect(container.read(counterProvider).busy, true);
    await f;
    expect(container.read(counterProvider).count, 1);
    expect(container.read(counterProvider).busy, false);
  });
}
```

Override providers to inject fakes (`apiClientProvider.overrideWithValue(FakeApi())`) and you no longer need a mocking framework for most cases. Listeners pause when not visible in Riverpod 3, but in tests every container is "visible" by default unless you explicitly model it, so the change is invisible to existing test suites.

## Gotchas the migration always hits

**`autoDispose` versus singletons.** Code-generated `@riverpod` providers are auto-dispose by default. If you converted a `Get.put(permanent: true)` controller and notice that state resets when you leave the screen, mark the provider `@Riverpod(keepAlive: true)`. Do this deliberately; permanent state is a memory leak waiting to happen.

**Reading providers in `initState`.** A common GetX pattern is `final c = Get.find<MyController>()` in `initState`. The Riverpod equivalent is `ref.read(myProvider.notifier)` in `initState`, but only inside a `ConsumerStatefulWidget`. Reading inside `build` is fine for `ref.watch`; reading `notifier` once in `initState` and stashing it is a smell, because the notifier identity can change after a `ref.invalidate`. Prefer `ref.read` at the call site.

**Background tasks under route changes.** Riverpod 3 pauses listeners in invisible widgets, which is usually what you want, but it changes the timing of work that was previously kept alive by GetX's eager `Obx`. If a network refresh has to keep running while the user is on another tab, give that work to a `keepAlive: true` `AsyncNotifier` rather than expecting a paused widget to drive it.

**Hot restart drops the GetX side first.** During the dual-library phase, a hot restart resets `Get.put` instances but Riverpod state survives if the `ProviderScope` is at the top of the tree. That is genuinely useful for migration: you can hot-restart, see Riverpod-owned state hold, and confirm what you have left to move.

**`Obx` build errors after deletion.** When you remove the GetX import from a file, leftover `Obx(...)` calls become a hard compile error rather than a runtime warning. Search the project for `Obx(` and `GetBuilder<` before you commit; the compiler will catch them but a single grep pass saves a build cycle.

## How this fits with the rest of your Flutter pipeline

The migration is rarely the only Flutter task in flight. If you also run [a multi-version CI matrix](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), pin both `flutter_riverpod` and the generated `*.g.dart` files explicitly so a Dart SDK bump does not silently regenerate boilerplate that breaks an old branch. CPU-bound work that used to live in a GetX controller (parsing, hashing, large reduces) belongs [in a Dart isolate](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) anyway, and the move to `AsyncNotifier` makes that handoff cleaner because the loading state is already first-class. If a notifier needs to call native code, [add it through a platform channel without writing a plugin](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), then expose the channel as its own provider so tests can override it. And when the migration is done and you ship a build that needs to be debugged on a real device, the [iOS-from-Windows device workflow](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) still applies; nothing about the state library changes how the observatory port behaves.

The shortest mental model for the migration: GetX trades correctness for ergonomics, Riverpod trades ergonomics for correctness. You are not rewriting your app, you are renaming and re-scoping its state graph. Do it screen by screen, leave the dual-library phase running until every `Get.find` is gone, and do not skip the routing step. By the time the last `package:get` import comes out of `pubspec.yaml`, the codebase will be smaller, and the tests will be the part you stop dreading.

## Source links

- [Riverpod 3.0 migration guide](https://riverpod.dev/docs/3.0_migration)
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
- [riverpod_generator on pub.dev](https://pub.dev/packages/riverpod_generator)
- [go_router on pub.dev](https://pub.dev/packages/go_router)
- [Riverpod testing recipes](https://riverpod.dev/docs/essentials/testing)
- [GetX package on pub.dev](https://pub.dev/packages/get)
