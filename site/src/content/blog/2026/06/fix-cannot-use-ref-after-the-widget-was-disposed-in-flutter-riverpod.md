---
title: "Fix: Bad state: Cannot use \"ref\" after the widget was disposed in Flutter Riverpod"
description: "This crash means a WidgetRef was used after its widget left the tree, usually in an async callback. Read what you need before the await, then guard with a mounted check."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

Your code touched a Riverpod `WidgetRef` after the widget that owns it was disposed. The usual culprit is an async callback (an `await`, `Future.then`, `Timer`, or stream listener) that completes after the user navigated away, and then calls `ref.read`, `ref.watch`, or `ref.listen`. The fix is to read everything you need from `ref` before the `await`, and guard any post-await work with an `if (!mounted) return;` check. This guide uses Flutter 3.44 (stable, May 2026), Dart 3.x, and Riverpod 3.0 (released September 2025).

A `WidgetRef` is bound to the lifetime of the widget it came from. The moment that widget is removed from the tree, the ref is invalidated, and any further use throws. This is by design: a disposed widget has no business reading or writing providers, and Riverpod would rather fail loudly than silently leak state into a screen the user already left.

## The error in context

The full message Riverpod throws looks like this:

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

The stack frame in your own code names the line that touched the dead ref: a `ref.read(...)`, `ref.watch(...)`, or `ref.listen(...)` call. That frame is where the exception surfaces, but the reason it fired is earlier in time, when the widget was disposed before that line ran.

There is a closely related variant with a slightly different noun:

```
Bad state: Cannot use "ref" after the provider was disposed.
```

That one comes from the `Ref` inside a `Notifier` or `AsyncNotifier`, not a `WidgetRef` in a widget. Same family, same root cause, different owner. The widget version says "widget"; the provider version says "provider". The fix differs slightly, and the section on Notifiers below covers it.

## Why this happens

There are four causes, in rough order of how often they bite.

A `WidgetRef` was captured in an async callback that outlived the widget. You started an `await`, a `Future.then`, a `Timer`, or a `stream.listen` while the screen was alive, the user popped the route (which disposes the `ConsumerState` and invalidates its `ref`), and then the callback completed and called `ref.read`. This is by far the most common cause, because it only crashes when the timing lines up: it passes every time the awaited work is fast and crashes when the network is slow or the user is quick.

You used `ref` inside `dispose()`. A `ConsumerState.dispose()` that calls `ref.read` to do cleanup (cancel a subscription, flush a buffer, notify a provider) hits this error, because by the time `dispose` runs the `WidgetRef` is already torn down. The Riverpod team tracks this exact shape in [issue 4142](https://github.com/rrousselGit/riverpod/issues/4142): the widget still looks mounted, but the element's ref is gone. The cleanup must happen through the provider's own `ref.onDispose`, not the widget's `dispose`.

You stored a `WidgetRef` in a long-lived object. A controller, service, or "logic" class that holds onto the `ref` it was handed in `build` will keep a stale reference. When the widget rebuilds or leaves, that stored ref points at a disposed element. A `WidgetRef` is not a durable handle; it is valid only for the widget instance that owns it.

A provider was disposed across an async gap inside a Notifier. In an `autoDispose` Notifier, you `await` something, the provider loses its last listener (or is invalidated) during the gap, Riverpod disposes it, and the line after the `await` reads `ref`. This is the "after the provider was disposed" variant. Riverpod 3.0 made this rarer by pausing listeners on rebuild instead of dropping them immediately, but an `autoDispose` provider that genuinely loses all watchers mid-await still disposes. The issue is discussed in [riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096).

The underlying contract, from the Riverpod 3.0 release notes: "Refs and Notifiers can no longer be interacted with after they have been disposed." Riverpod 3.0 throws on any post-dispose interaction rather than tolerating it, which is why code that used to fail quietly in 2.x now crashes loudly. That is the framework doing its job.

## A minimal repro

This screen crashes when you leave it before the submit completes. It compiles and runs, and it passes every time the network is fast.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- throws "Cannot use \"ref\" after the widget was disposed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cartProvider = NotifierProvider<CartNotifier, int>(CartNotifier.new);

class CartNotifier extends Notifier<int> {
  @override
  int build() => 3;
  void clear() => state = 0;
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Future<void> _submit() async {
    // Pretend this posts the order and takes ~800ms.
    await Future.delayed(const Duration(milliseconds: 800));
    // If the user popped this screen during those 800ms, the ConsumerState and
    // its WidgetRef are already disposed. This line then throws.
    ref.read(cartProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: _submit,
          child: const Text('Place order'),
        ),
      ),
    );
  }
}
```

Tap "Place order", then pop the screen within 800 milliseconds. The `ConsumerState` is disposed, its `ref` is invalidated, the `Future` completes, and `ref.read(cartProvider.notifier)` throws. The crash is timing-dependent, which is exactly why it survives code review and ships.

## Fix, in detail

The fixes are ordered by how much I recommend them. Pick the one that matches your cause.

### 1. Read before the await, guard the rest with mounted (recommended)

Two rules cover almost every widget-side occurrence. First, resolve everything you need from `ref` before the `await`, while the widget is guaranteed alive. Second, after the `await`, check `mounted` before touching the tree, `setState`, or any further `ref` call.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- correct.
Future<void> _submit() async {
  // Resolve the notifier BEFORE the await, while ref is still valid.
  final cart = ref.read(cartProvider.notifier);

  await Future.delayed(const Duration(milliseconds: 800)); // post the order

  if (!mounted) return; // the ConsumerState (and its WidgetRef) may be gone
  cart.clear();
}
```

`cart` is a plain object reference to the notifier; it does not go stale when the widget is disposed, so calling `cart.clear()` after the await is safe. The `mounted` check stops you from also driving UI (a `setState`, a `Navigator.push`, a `ScaffoldMessenger` call) on a dead widget. `mounted` here is the standard `State.mounted`, which `ConsumerState` exposes like any other `State`.

The rule is the same one that fixes the controller-disposal crashes: after every `await` in a `State` method, the next line that touches `this`, `ref`, or the tree must be preceded by a `mounted` check. The Dart analyzer's `use_build_context_synchronously` lint catches the `BuildContext` version of this mistake; treat `ref` exactly the same way. The same discipline appears in the [TextEditingController used after being disposed fix](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), because it is the same class of bug with a different object.

### 2. In a Notifier, check ref.mounted after the async gap

If the crash is the "after the provider was disposed" variant, you are inside a `Notifier` or `AsyncNotifier`, not a widget. Riverpod 3.0 added `Ref.mounted`, the provider-side equivalent of `BuildContext.mounted`. Read dependencies before the await, then gate the state write on `ref.mounted`.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0
class OrdersNotifier extends AsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => _repo().fetch();

  OrderRepository _repo() => ref.read(orderRepositoryProvider);

  Future<void> refresh() async {
    final repo = _repo(); // read deps before the gap
    final next = await AsyncValue.guard(repo.fetch);

    if (!ref.mounted) return; // the provider may have been disposed mid-fetch
    state = next;
  }
}
```

Before Riverpod 3.0 there was no `ref.mounted`, and the common workaround was a small mixin that flips a flag in `ref.onDispose`. On 3.0 you can delete that mixin: `ref.mounted` is the supported check. Setting `state` on a disposed notifier is what throws, so the guard goes immediately before the assignment. This is the same shape that keeps [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) safe across an async gap.

### 3. Do not store a WidgetRef in a logic class

If the crash is not async, it is often a stored ref. A `WidgetRef` belongs to one widget instance and dies with it, so a controller or service that hangs onto it will eventually dereference a corpse. Move the logic into a Notifier and let it use the provider's always-alive `Ref` instead.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- the logic owns a durable Ref, not a WidgetRef.
final sessionProvider = NotifierProvider<SessionNotifier, Session?>(SessionNotifier.new);

class SessionNotifier extends Notifier<Session?> {
  @override
  Session? build() => null;

  Future<void> signOut() async {
    await ref.read(authProvider).signOut(); // ref here is the provider's Ref
    if (!ref.mounted) return;
    state = null;
  }
}
```

Widgets then call `ref.read(sessionProvider.notifier).signOut()` from an event handler, and the long-running work lives behind a `Ref` that Riverpod keeps alive for as long as the provider is in use. The widget never has to outlive its own `ref`. Moving lifecycle ownership out of widgets and into Notifiers is exactly the shape a [GetX to Riverpod migration](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) is built around, and it is one of the reasons [Riverpod is the default state-management pick in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

### 4. Never use ref inside the widget's dispose()

Cleanup that needs a provider does not belong in `ConsumerState.dispose()`, because the `WidgetRef` is already invalidated by then. There are two correct homes for it. If the resource is owned by a provider, register the cleanup with `ref.onDispose` inside that provider, where it runs when the provider is disposed:

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- cleanup lives with the provider, not the widget.
final socketProvider = NotifierProvider<SocketNotifier, void>(SocketNotifier.new);

class SocketNotifier extends Notifier<void> {
  late final WebSocketChannel _channel;

  @override
  void build() {
    _channel = WebSocketChannel.connect(Uri.parse('wss://example.com'));
    ref.onDispose(_channel.sink.close); // runs when the provider goes away
  }
}
```

If you genuinely must do something at widget teardown, capture the plain object (the notifier, the subscription, the value) in `initState` or `didChangeDependencies` and store it in a field, then use that field in `dispose()`. Do not call `ref.read` from `dispose` itself.

## Gotchas and variants

`Cannot use "ref" after the provider was disposed`. The Notifier-side twin of this error, covered by fix 2 above. If the stack frame is inside a `Notifier`/`AsyncNotifier` rather than a `ConsumerState`, you want `ref.mounted`, not `State.mounted`. The two messages differ by one word and that word tells you which check to use.

`ref.read` in `onPressed` works, `ref.read` after `await` in the same handler does not. The synchronous part of an event handler runs while the widget is alive, so a bare `ref.read` at the top of `onPressed` is fine. It is only the code after an `await` that can land on a disposed widget. The dividing line is the first `await`, not the handler.

The crash only happens sometimes. That is the signature of the async cause, not a flaky framework. A fast backend hides it; a slow one or a fast user exposes it. Reproduce it deterministically by adding an artificial `Future.delayed` before the `ref` call and popping the screen during the delay, exactly as the repro above does.

It started after upgrading to Riverpod 3.0. Riverpod 3.0 throws on post-dispose interaction where 2.x sometimes tolerated it. Code that "worked" before was already touching a disposed ref; 3.0 surfaced a latent bug rather than introducing one. The release notes state plainly that refs and notifiers can no longer be used after disposal. Fix the access, do not pin back to 2.x to hide it.

`ConsumerWidget` (stateless) hitting this. A `ConsumerWidget` has no `mounted`, because it has no `State`. If you capture its `ref` in a callback that survives the widget, move to a `ConsumerStatefulWidget` so you have a `mounted` flag to guard with, or push the async work into a Notifier (fix 3) so the widget never holds the ref past its own life.

`use_build_context_synchronously` does not flag `ref`. The analyzer lint that catches a `BuildContext` used after an await has no built-in equivalent for `WidgetRef`. Static analyzers such as DCM and the Riverpod 3.0 lint set add rules for it (read-ref-and-state synchronously), and they are worth turning on, but out of the box the compiler will not warn you. Treat every `ref` after an `await` as suspect the same way you treat `context`.

The single discipline that removes this whole class of bug: a `WidgetRef` is valid only inside the synchronous body of the widget that owns it, so read what you need before any `await`, guard everything after with `mounted` (widgets) or `ref.mounted` (Notifiers), and keep durable logic in providers rather than in widgets that come and go. Wire that into your async-handler reflex and the error stops appearing. It is the same `mounted`-guard reflex that fixes the [setState or markNeedsBuild called during build error](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/), and the slow-response timing that triggers it usually traces back to [how the app handles network errors](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Related

- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) is the same after-dispose crash for controllers, with the same mounted-guard fix.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) keeps async results in a Notifier's state, off the dangerous post-await path.
- [Fix: setState() or markNeedsBuild() called during build in Flutter](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) shares the mounted-guard discipline for async callbacks.
- [How to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) shows how to move logic into Notifiers that own a durable Ref.
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) covers why Notifier-owned lifecycle is the modern default.

## Sources

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- introduces `Ref.mounted` and the "refs and notifiers can no longer be interacted with after they have been disposed" rule.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- on the lifetime of `WidgetRef` versus a provider's `Ref`.
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- the error thrown when using `ref` in a widget's `dispose` callback.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- using `ref` in a Notifier after an async gap, and the 3.0 listener-pausing fix.
- [Checking if an AsyncNotifier is mounted, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- the `ref.mounted` pattern in Riverpod 3.0 and the legacy 2.x mixin.
