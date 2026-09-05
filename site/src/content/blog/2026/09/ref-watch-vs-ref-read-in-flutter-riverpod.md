---
title: "ref.watch vs ref.read in Riverpod: what is the difference and when do I use each?"
description: "ref.watch subscribes and rebuilds, ref.read reads once and never rebuilds. Use watch in every build method and read only inside event callbacks. Here is the decision matrix, the source of both methods in flutter_riverpod 3.4.3, and the four silent failure modes: watch in a callback, read in a provider body, read on an autoDispose provider, and read used as an optimization."
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
---

`ref.watch` registers a subscription, `ref.read` does not. That single difference decides everything else. Use `ref.watch` inside `build` methods, both the `build` of a `ConsumerWidget` and the `build` of a provider or `Notifier`, and use `ref.read` inside code that runs once in reaction to an event: `onPressed`, `onTap`, a `Timer` callback, a mutation method on a `Notifier`. The choice is not a performance trade-off, it is a call-site rule: code that reruns when state changes must watch, code that runs exactly once must read. Everything below is verified against `riverpod` and `flutter_riverpod` 3.4.3 (published 2026-09-03) on Flutter 3.47.2 stable with Dart 3.13.2, plus `riverpod_lint` 3.1.9.

## The decision matrix

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| Registers a subscription | yes | no |
| Rebuilds the caller when the value changes | yes | never |
| Keeps an `autoDispose` provider alive | yes | no |
| Correct inside `build` | yes, this is the only place | almost always a bug |
| Correct inside `onPressed` / `onTap` / timers | no | yes, this is the only place |
| Correct inside `initState` | no | yes, for a one-shot seed |
| Correct inside a `Notifier` mutation method | no | yes |
| Paused when the widget is off-screen (Riverpod 3 `TickerMode`) | yes | not applicable |
| Notifications filtered by `==` | yes | not applicable |
| Throws if you call it in the wrong place | no, it fails silently | no |
| Tool for reducing rebuilds | `.select` | not this |

The two rows that cost people the most debugging time are the last two. There is no runtime guard on either method, and `ref.read` is not the way to cut rebuilds.

## The two methods live on two different classes

Riverpod exposes `watch` and `read` twice, on two unrelated types, and the implementations are genuinely different.

`WidgetRef` is what a `ConsumerWidget`, a `Consumer` builder, or a `ConsumerState` gives you. Its implementation lives on `ConsumerStatefulElement`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> target) {
  _assertNotDisposed();
  return _dependencies
          .putIfAbsent(target, () {
            final oldDependency = _oldDependencies?.remove(target);
            if (oldDependency != null) {
              return oldDependency;
            }
            final sub = container.listen<StateT>(
              target,
              (_, _) => markNeedsBuild(),
            );
            _applyTickerMode(sub);
            return sub;
          })
          .readSafe()
          .valueOrProviderException
      as StateT;
}

@override
StateT read<StateT>(ProviderListenable<StateT> provider) {
  _assertNotDisposed();
  return ProviderScope.containerOf(this, listen: false).read(provider);
}
```

`watch` stores a `ProviderSubscription` in a per-element `_dependencies` map whose listener calls `markNeedsBuild()`. `read` reaches the `ProviderContainer` with `listen: false` and calls `read` on it. No map entry, no listener, no rebuild, ever.

`Ref` is what a provider body or a `Notifier` gets. Same names, different mechanics:

```dart
// package:riverpod/src/core/ref.dart, riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  late ProviderSubscription<StateT> sub;
  sub = _element.listen<StateT>(
    listenable,
    (prev, value) => _invalidateSelf(asReload: true, manual: false),
    onError: (err, stack) => _invalidateSelf(asReload: true, manual: false),
    onDependencyMayHaveChanged: _element._markDependencyMayHaveChanged,
  );
  return sub.readSafe().valueOrProviderException;
}

@override
StateT read<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  final result = container.read(listenable);
  if (kDebugMode) _debugAssertCanDependOn(listenable);
  return result;
}
```

On the provider side, `watch` is `listen` plus `invalidateSelf`, which the official docs spell out in the `Ref.watch` doc comment. `read` is a plain container read. The pattern is identical on both classes: watch builds a graph edge, read does not.

## The rule is about the call site, not about the provider

Ask one question: does this line of code need to run again when the value changes?

- Inside `build`, yes. The whole point of `build` is that Riverpod can call it again. Use `ref.watch`.
- Inside `onPressed`, no. The user will press the button again and the callback will run again with a fresh value. Use `ref.read`.

The official documentation is blunt about the direction of the default. From the Riverpod refs page: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." And from `Ref.read`'s own doc comment in 3.4.3: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

Here is the shape that is correct in every version of Riverpod since 2.0:

```dart
// flutter_riverpod 3.4.3, Flutter 3.47.2, Dart 3.13.2
final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Rerun this line on every change: watch.
    final count = ref.watch(counterProvider);

    return Column(
      children: [
        Text('$count'),
        ElevatedButton(
          // Runs once per tap: read.
          onPressed: () => ref.read(counterProvider.notifier).increment(),
          child: const Text('increment'),
        ),
      ],
    );
  }
}
```

## ref.watch inside a callback does not throw, and that is the whole problem

If you move `ref.watch(counterProvider)` into the `onPressed` closure, the app compiles, the analyzer stays quiet, and the value you get back is correct. Nothing in `riverpod_lint` 3.1.9 flags it: the rule set is `missing_provider_scope`, `provider_dependencies`, `scoped_providers_should_specify_dependencies`, `avoid_build_context_in_providers`, `provider_parameters`, `avoid_public_notifier_properties`, `unsupported_provider_value`, `functional_ref`, `notifier_extends`, `avoid_ref_inside_state_dispose`, `avoid_keep_alive_dependency_inside_auto_dispose`, `notifier_build`, `riverpod_syntax_error`, `async_value_nullable_pattern`, and `protected_notifier_properties`. None of them is "watch outside build".

What actually happens is worse than a crash. Look back at `ConsumerStatefulElement.build`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
Widget build() {
  if (_tickerModeNotifier == null) {
    _updateTickerModeNotifier();
  }
  try {
    _oldDependencies = _dependencies;
    for (var i = 0; i < _listeners.length; i++) {
      _listeners[i].close();
    }
    _listeners.clear();
    _dependencies = {};
    return super.build();
  } finally {
    for (final dep in _oldDependencies!.values) {
      dep.close();
    }
    _oldDependencies = null;
  }
}
```

Every build swaps `_dependencies` for a fresh map and closes whatever survived from the previous one. A `ref.watch` called from `onPressed` runs when `_oldDependencies` is `null`, so it inserts a brand new subscription into the live `_dependencies` map. From that moment until the next rebuild, the widget is subscribed to a provider that its `build` method never mentions. If the provider changes in that window, `markNeedsBuild` fires and the widget rebuilds. Then the rebuild drops the subscription, because `build` does not re-register it, and the second change does nothing.

That is one-shot reactivity that depends on frame timing. It is exactly the kind of bug that only reproduces on a slow device.

Note the contrast with `ref.listen`, which does guard itself:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
void listen<StateT>(
  ProviderListenable<StateT> provider,
  void Function(StateT? previous, StateT value) listener, {
  void Function(Object error, StackTrace stackTrace)? onError,
  bool weak = false,
}) {
  _assertNotDisposed();
  assert(
    debugDoingBuild,
    'ref.listen can only be used within the build method of a ConsumerWidget',
  );
  ...
}
```

`listen` asserts in debug builds. `watch` does not. Do not read the absence of an assertion as permission.

## ref.read in a provider body freezes the dependency forever

The same mistake on the provider side is quieter still, because there is no widget to visibly fail to rebuild.

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` computes once and caches the result. Changing the locale rebuilds `localeProvider` and every widget that watches it, and leaves `greetingProvider` sitting on a stale string until something else invalidates it. Swap in `ref.watch(localeProvider)` and the edge exists: `Ref.watch` calls `_invalidateSelf(asReload: true)` on every change, so `greetingProvider` recomputes on demand.

The same applies inside a `Notifier`. `Notifier.build`'s doc comment in 3.4.3 says it directly: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." Watch in `build`. In `increment()` or `submit()`, read.

## ref.read on an autoDispose provider throws the work away

This is the one that produces a bug report titled "my state resets to zero".

Automatic disposal is tracked by listeners, not by reads. With code generation, `@riverpod` defaults to `keepAlive: false`, so every generated provider is auto-disposing unless you say otherwise:

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

Hand-written providers are the other way around. `NotifierProvider` and `Provider` in `riverpod` 3.4.3 both declare `super.isAutoDispose = false`, so they are kept alive by default and you opt in with `NotifierProvider.autoDispose` or `isAutoDispose: true`.

Now consider a generated, auto-disposing counter that nothing on screen is watching:

```dart
// riverpod_generator 4.x, riverpod 3.4.3
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

// In a widget that does NOT watch counterProvider anywhere:
onPressed: () {
  ref.read(counterProvider.notifier).increment(); // state becomes 1
},
```

`ref.read` creates the provider, runs `build()`, returns the notifier, and adds no listener. The disposal docs describe the timing: when the listener count reaches zero the provider is "considered 'not used'", Riverpod "waits for one frame", and if it is still unused the provider is destroyed. So the increment lands on a `Counter` that gets torn down a frame later. The next tap starts from `0` again.

The fix is not `ref.watch` in the callback. It is to make sure something legitimately watches the provider, usually the widget that displays the count, or to call `ref.keepAlive()` inside `build` if the state genuinely must outlive its listeners.

## Watch the value, read the notifier

`ref.read(counterProvider.notifier)` is the canonical way to reach mutation methods, and it appears verbatim in the `Notifier` doc comment. `ref.watch(counterProvider.notifier)` is not a crime, but it is pointless: Riverpod filters all notifications by `==` in 3.x, and the `Notifier` doc comment states that when `build` re-executes "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." The same instance compares equal to itself, so watching `.notifier` almost never emits. It only emits when the provider is fully disposed and recreated. You get a subscription that buys you nothing except an auto-dispose keep-alive you did not ask for.

So: `ref.watch(provider)` for the value, `ref.read(provider.notifier)` for the methods.

## initState wants neither of them

In a `ConsumerState`, `initState` runs before the first `build`. `ref.watch` there does not throw, but the subscription it creates is dropped by the first build unless `build` happens to watch the same provider, which makes the behaviour accidental. `ref.listen` throws its `debugDoingBuild` assertion. The supported API is `listenManual`:

```dart
// flutter_riverpod 3.4.3
class _FormState extends ConsumerState<MyForm> {
  late final ProviderSubscription<AsyncValue<void>> _sub;

  @override
  void initState() {
    super.initState();
    // Seed a controller once: read is correct here.
    _controller.text = ref.read(draftProvider);

    // Subscribe outside build: listenManual is correct here.
    _sub = ref.listenManual(submitProvider, (previous, next) {
      next.whenOrNull(error: (e, _) => showErrorBar(context, e));
    });
  }
}
```

`listenManual` deliberately reads the container with `listen: false` so it is safe in `initState`, and `ConsumerStatefulElement.unmount` closes manual listeners after `State.dispose` runs. You do not need to close it yourself, though the returned subscription lets you.

While you are in `State` lifecycle code, remember the other end: touching `ref` in `dispose` throws, and `riverpod_lint`'s `avoid_ref_inside_state_dispose` exists for exactly that. The message in 3.4.3 is `Using "ref" when a widget is about to or has been unmounted is unsafe.`, which is the current wording of the older [Cannot use "ref" after the widget was disposed error](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Riverpod 3 pauses watch subscriptions, which kills the last argument for read

The "read is cheaper" folklore predates Riverpod 3. In 3.x, subscriptions created by `WidgetRef.watch` participate in `TickerMode`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
void _updateTickerMode() {
  final isActive = _tickerModeNotifier!.value;
  if (isActive != _isActive) {
    _isActive = isActive;
    for (final sub in _dependencies.values) {
      if (isActive) {
        sub.resume();
      } else {
        sub.pause();
      }
    }
  }
}
```

When a widget goes off-screen, in an inactive `TabBarView` tab or under a pushed route, every one of its watch subscriptions is paused and the providers behind them stop doing work. There is no equivalent saving to be had by switching to `ref.read`, because `ref.read` never had a subscription to pause in the first place. The runtime cost of a watch is one entry in a `HashMap` plus one listener callback, which is not the thing making your frame budget hurt.

If you actually want fewer rebuilds, the tool is `.select`, not `read`:

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` keeps the subscription, which means it keeps the reactivity and the keep-alive, and only filters what counts as a change. That is the optimization. `ref.read` is not an optimization, it is the removal of a feature.

Note that `==` filtering is global in Riverpod 3.0 and it applies to `watch`, `select`, and `listen` alike, which is its own class of surprise when your state class does not implement equality. If a watch is not firing when you expect it to, check `==` before you blame the call site: that is the same mechanism behind [StreamProvider dropping events in Riverpod 3.0](/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## What to actually type

Default to `ref.watch`. Reach for `ref.read` in exactly three places: an event callback, a mutation method on a `Notifier`, and a `Ref` you deliberately stored on a plain service class so that the service can pull current values without being recreated, which is the use case `Ref.read`'s own documentation shows. Everywhere else, watch. If you find yourself replacing a watch with a read to stop something rebuilding, you have found a `select` opportunity or a provider that is scoped too coarsely, not a reason to cut the edge out of the graph.

And if a `ref.watch` looks like it belongs in a callback, the thing you probably want is `ref.listen` in `build` (for side effects while the widget is alive) or `ref.listenManual` in `initState` (for side effects tied to `State`).

## Related

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [Checking ref.mounted after an async gap in Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Which Riverpod package to install: riverpod, flutter_riverpod, or hooks_riverpod](/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [Showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [The full Riverpod 2.x to 3.0 migration guide](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Sources

- [Refs](https://riverpod.dev/docs/concepts2/refs), the official page for `Ref.watch`, `Ref.read`, and `Ref.listen`.
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose), on the one-frame grace period and listener-count tracking.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), on `==` filtering and `TickerMode`-driven pausing.
- [flutter_riverpod 3.4.3 on pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.3), source of `ConsumerStatefulElement` quoted above.
- [riverpod 3.4.3 on pub.dev](https://pub.dev/packages/riverpod/versions/3.4.3), source of `Ref.watch` and `Ref.read` quoted above.
- [riverpod_lint 3.1.9 on pub.dev](https://pub.dev/packages/riverpod_lint), the complete rule list referenced above.
