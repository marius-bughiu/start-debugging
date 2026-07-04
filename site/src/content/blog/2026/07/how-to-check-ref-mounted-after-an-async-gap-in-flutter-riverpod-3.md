---
title: "How to Check Ref.mounted After an Async Gap in Flutter Riverpod 3"
description: "In a Notifier, resolve dependencies before the await, then guard the state write with if (!ref.mounted) return. This is the Riverpod 3.0 replacement for the old onDispose mixin, and it stops UnmountedRefException when a provider is disposed mid-await. Tested on flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
---

The rule is short: inside a `Notifier` or `AsyncNotifier`, an `await` can dispose the provider before your code resumes, and writing `state` on a disposed provider throws. So read everything you need from `ref` before the first `await`, do the async work, then guard the state write with `if (!ref.mounted) return;`. `Ref.mounted` is a Riverpod 3.0 property, the provider-side twin of `BuildContext.mounted`, and it is the supported way to ask "is this provider still alive?" after an async gap. This guide is tested on `flutter_riverpod` 3.x (the 3.0 line shipped in September 2025; the current release is 3.3.2), Flutter 3.44 (stable, May 2026), and Dart 3.x.

If you have ever written a custom mixin that flips a boolean in `ref.onDispose` so you could check it after an await, you can delete it now. `Ref.mounted` does exactly that, correctly, with no boilerplate.

## Why an await can leave a provider disposed

A provider's `Ref` is bound to the lifetime of that provider. When the provider is disposed, its `Ref` is invalidated, and Riverpod 3.0 throws on any further interaction with it, including reading `ref`, calling `ref.read`, or assigning `state`. The exception you get is `UnmountedRefException`: "using `ref` or `state` after an async gap will throw if the notifier is already unmounted."

The reason this bites specifically after an `await` is the async gap. Three things can dispose a provider while you are suspended on a `Future`:

An `autoDispose` provider loses its last listener. If the widget watching the provider is popped during the await, the provider has nobody left listening, so Riverpod disposes it. Your continuation then wakes up holding a dead `Ref`.

The provider is explicitly invalidated. Another part of the app calls `ref.invalidate(myProvider)` or `ref.refresh(myProvider)` during the gap, which tears down the current instance and builds a fresh one. The old instance's `Ref`, the one your suspended method is holding, is now disposed.

A dependency changes. The provider `watch`es something that changed, forcing a rebuild. The previous build's `Ref` is retired.

Riverpod 3.0 made the first case rarer by pausing listeners across a rebuild instead of dropping them immediately, so a provider that is merely rebuilding does not eagerly dispose. But a genuinely orphaned `autoDispose` provider, one that loses all watchers mid-await, still disposes. The lifecycle change reduced the false positives; it did not remove the real ones. This is the exact scenario tracked in [riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096).

The important mental model: the crash is timing-dependent. When the awaited work is fast, the provider is usually still alive when you resume and everything works. When the network is slow or the user navigates quickly, the provider disposes first and the state write throws. That is why this bug passes code review, passes on your machine, and crashes in production.

## The smallest reproduction

This `AsyncNotifier` fetches a list, then writes it back to `state` after the await. It compiles, runs, and passes every time the fetch is fast.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- throws UnmountedRefException.
import 'package:flutter_riverpod/flutter_riverpod.dart';

final ordersProvider =
    AsyncNotifierProvider.autoDispose<OrdersNotifier, List<Order>>(
  OrdersNotifier.new,
);

class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    state = const AsyncLoading();
    // ~800ms round trip. If the screen that watches ordersProvider is popped
    // during this await, the autoDispose provider loses its last listener and
    // is disposed. The line below then runs on a dead Ref.
    final orders = await ref.read(orderRepositoryProvider).fetch();
    state = AsyncData(orders); // throws UnmountedRefException
  }
}
```

Trigger `refresh()`, pop the screen within the 800 milliseconds, and the `state = AsyncData(orders)` line throws. Nothing is wrong with the fetch. The problem is that `refresh` assumed the provider would still exist when the `Future` completed, and for an `autoDispose` provider whose watcher left, it does not.

## The fix, step by step

Two rules cover almost every occurrence. Resolve your dependencies before the gap, and guard the state write after it.

1. **Read every dependency you need before the first `await`.** While the provider is guaranteed alive (the synchronous part of your method), call `ref.read` for each service, repository, or notifier you will use, and store the results in local variables. A plain object reference does not go stale when the provider is disposed; only the `Ref` does.

2. **Do the async work.** Await your `Future`s using the local variables you captured. Do not touch `ref` inside the awaited expressions if you can avoid it.

3. **Guard the resume with `ref.mounted`.** Immediately before you assign `state` (or call any `ref` method), check `if (!ref.mounted) return;`. If the provider was disposed during the gap, you bail out cleanly instead of throwing.

4. **Assign `state`.** Now the write lands on a live provider.

Here is the corrected notifier:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- correct.
class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    final repo = ref.read(orderRepositoryProvider); // 1. read deps first
    state = const AsyncLoading();

    final next = await AsyncValue.guard(repo.fetch); // 2. async work

    if (!ref.mounted) return; // 3. the provider may be gone
    state = next;             // 4. safe write
  }
}
```

`repo` is a durable object handle; it works fine after the await even if the provider is dead. The `ref.mounted` check is what stops the crash: it returns `false` when the provider has been disposed, so the `state` assignment never runs against an invalidated `Ref`. This is the same discipline that keeps [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) safe, and it is structurally identical to the [BuildContext-after-await guard](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) on the widget side.

The official Riverpod 3.0 docs show precisely this pattern:

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted, WidgetRef, and context.mounted: which check goes where

The single most common source of confusion is which `mounted` you want, because there are three of them and they live on three different objects.

`ref.mounted` is on the provider's `Ref`, the one you get inside a `Notifier`, `AsyncNotifier`, or a functional provider body (`Ref ref`). Use it when the async code lives in a provider. This is the property Riverpod 3.0 added; it did not exist in 2.x.

`context.mounted` is on `BuildContext`. Use it when the async code lives in a widget and you need to touch the tree afterward (`Navigator`, `ScaffoldMessenger`, `Theme.of`). The Dart analyzer's `use_build_context_synchronously` lint enforces this one.

`State.mounted` is on `State` (and therefore `ConsumerState`). Use it in a `ConsumerStatefulWidget` before calling `setState` or reading `WidgetRef` after an await. Note the trap: a `WidgetRef` in a widget is not the same object as a provider's `Ref`, and it does not have `ref.mounted`. In a widget you guard with `context.mounted` or `State.mounted`, not `ref.mounted`.

The rule of thumb: if the stack frame that throws is inside a `Notifier` or `AsyncNotifier`, you want `ref.mounted`. If it is inside a `ConsumerState` or a `ConsumerWidget` build/callback, you want `context.mounted` or `State.mounted`. Getting this wrong is the root of the closely related [Cannot use "ref" after the widget was disposed crash](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/), whose provider-side variant this guide is the proactive answer to.

## The 2.x mixin you can now delete

Before Riverpod 3.0 there was no `Ref.mounted`, so the community workaround was a mixin that tracked disposal manually:

```dart
// Riverpod 2.x workaround -- no longer needed on 3.0.
mixin NotifierMounted {
  bool _mounted = true;
  void setUnmounted() => _mounted = false;
  bool get mounted => _mounted;
}

class SomeNotifier extends AutoDisposeAsyncNotifier<void>
    with NotifierMounted {
  @override
  FutureOr<void> build() {
    ref.onDispose(setUnmounted); // flip the flag when disposed
  }

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (mounted) {
      state = next;
    }
  }
}
```

This worked, but Riverpod's maintainer explicitly discouraged it, and it had sharp edges (you had to remember to register `onDispose`, and the flag lived on the notifier instance rather than the ref). On 3.0 the whole mixin collapses to a single property:

```dart
// Riverpod 3.x -- the mixin is gone, ref.mounted is built in.
class SomeNotifier extends AutoDisposeAsyncNotifier<void> {
  @override
  FutureOr<void> build() {}

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (!ref.mounted) return;
    state = next;
  }
}
```

If you are upgrading from 2.x and see a `NotifierMounted` mixin (or any hand-rolled `_mounted` flag) in your codebase, that is dead weight now. Delete the mixin, delete the `ref.onDispose(setUnmounted)` line, and replace `if (mounted)` with `if (!ref.mounted) return;`.

## Gotchas and edge cases

**`ref.mounted` is not a substitute for `ref.onDispose` cleanup.** The guard prevents a write to a disposed provider; it does not clean up resources. If your provider owns a subscription, a socket, or a timer, register its teardown with `ref.onDispose` in `build`. And do not call `ref.read` inside an `onDispose` callback: the provider is already being disposed at that point, so `ref` is invalid and you will hit `UnmountedRefException` again. The DCM lint `avoid-ref-inside-state-dispose` flags exactly this.

**Reading an `autoDispose` provider via `.future` can dispose it after the first await.** There is a subtle case, discussed in [riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293), where an `autoDispose` provider read through its `.future` gets disposed after the first `await` because the temporary listener created by the read is released. If you are chaining reads across awaits, keep a real listener alive (watch it, or use `ref.keepAlive()`), rather than assuming `.future` holds the provider open.

**`ref.keepAlive()` changes the calculus.** A provider you have pinned with `ref.keepAlive()` will not `autoDispose` when its last widget leaves, so the "lost the last listener" cause disappears. It can still be disposed by an explicit `invalidate` or `refresh`, so keep the `ref.mounted` guard, but understand that pinning removes the most common trigger.

**`AsyncValue.guard` does not guard mounting.** `AsyncValue.guard` converts a thrown exception into an `AsyncError` so the error lands in your state instead of crashing. It does nothing about disposal. You still need the `if (!ref.mounted) return;` after it, before you assign the guarded result to `state`. The two mechanisms solve different problems: `guard` handles the Future failing, `ref.mounted` handles the provider disappearing.

**A `ConsumerWidget` has no `ref.mounted`.** Its `ref` is a `WidgetRef`, not a provider `Ref`. If you captured a `WidgetRef` in an async callback inside a stateless `ConsumerWidget`, there is no `mounted` to check. Move the async work into a Notifier so it runs behind a durable provider `Ref` (this is the shape a [FutureBuilder-to-AsyncNotifier migration](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) produces), or switch to a `ConsumerStatefulWidget` so you have `State.mounted`.

**It started throwing only after the 3.0 upgrade.** Riverpod 3.0 throws on post-dispose interaction where 2.x sometimes tolerated it silently. Code that "worked" before was already writing to a disposed provider; 3.0 surfaced a latent bug rather than creating one. Add the guard, do not pin back to 2.x to hide it.

## Let the linter catch the ones you miss

The guard is a habit, and habits slip. Two static-analysis rules turn "remember to check `ref.mounted`" into a build error. DCM ships `use-ref-and-state-synchronously`, which flags a `ref` or `state` access after an async gap that is not preceded by a mounted check, and `avoid-ref-inside-state-dispose` for the `onDispose` case. Riverpod's own lint set includes equivalents. Out of the box the Dart compiler will not warn you about `ref` after an await the way it does for `BuildContext`, so turning these rules on is the difference between catching the bug in CI and catching it in a crash report.

The one discipline that removes this whole class of bug: treat a provider's `Ref` exactly like a `BuildContext`. It is valid synchronously, an `await` can invalidate it, so read what you need before the gap and guard every post-await `ref` or `state` touch with `if (!ref.mounted) return;`. Wire that into your async-notifier reflex and `UnmountedRefException` stops appearing. It is one of the reasons [Riverpod's Notifier-owned lifecycle is the default state-management pick in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

## Related

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) is the reactive counterpart: the crash you get when you skip this guard, on both the widget and provider side.
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) is the same guard for the widget-side `context.mounted`.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) shows the `AsyncNotifier` plus `AsyncValue.guard` pattern this guard protects.
- [Migrate from FutureBuilder to a Riverpod AsyncNotifier in Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) moves async work into a provider where `ref.mounted` is available.
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) covers why Notifier-owned lifecycle is the modern default.

## Sources

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- introduces `Ref.mounted`, the `if (!ref.mounted) return;` pattern, and the pause-listeners-on-rebuild lifecycle change.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- on the lifetime of a provider's `Ref` versus a `WidgetRef`.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- using `ref` in a notifier after an async gap, and the 3.0 fix.
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) -- why `autoDispose` providers get disposed after the first `await` when read via `.future`.
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/) -- the lint that enforces a mounted check after an async gap.
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- the legacy 2.x mixin and the 3.0 `ref.mounted` replacement.
</content>
</invoke>
