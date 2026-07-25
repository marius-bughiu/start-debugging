---
title: "Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter"
description: "A step-by-step move from widget-local setState to a Riverpod 3.x Notifier: classify what actually leaves the widget, write the Notifier, convert to ConsumerWidget, and survive the == filtering, build() re-entry, and autoDispose defaults that bite setState refugees. Tested on Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
---

Moving one screen off `setState` and onto a Riverpod `Notifier` takes about an hour once you have done it twice, and most of that hour is deciding what should not move. This guide is tested on Flutter 3.44 (stable, May 2026), Dart 3.x, and `flutter_riverpod` 3.3.2, with `riverpod_generator` 4.0.4 and `riverpod_annotation` 4.0.3 for the code-generation variant. What breaks is rarely the compiler: the three things that bite are Riverpod 3.0 filtering notifications with `==` (so the in-place list mutation you got away with under `setState` now silently stops rebuilding the UI), `Notifier.build()` re-running where `initState` ran once, and auto-disposal defaulting differently for generated and hand-written providers. Do it when two widgets need the same state, or when you want to test the logic without pumping a widget. Do not do it for a screen that owns one boolean.

## Why this state should leave the widget

- **Two readers, one source.** A cart badge in the `AppBar` and a cart screen two routes away both need the line items. With `setState` you either lift the state to a common ancestor and drill callbacks down, or you keep two copies and hope they agree.
- **The logic becomes unit-testable.** A `Notifier` is a plain Dart object. You can drive it from a `ProviderContainer.test()` in a normal `test()` block, with no `pumpWidget`, no `WidgetTester`, and no frame scheduling.
- **State outlives the route when you want it to.** A `NotifierProvider` keeps its value across a `Navigator.pop`, which is what a cart, a draft form, or a multi-step wizard actually needs. Widget state dies with the element.
- **Mutations get names.** `setState(() => _lines = [..._lines, line])` scattered across six callbacks becomes `cartProvider.notifier.add(line)`, which is one place to log, guard, or throttle.

None of that argues for moving everything. A `TextEditingController`, an `AnimationController`, a `FocusNode`, a `ScrollController`, and a `GlobalKey<FormState>` all belong to the widget and should stay in a `State` object.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Widget base class | `StatefulWidget` becomes `ConsumerWidget`, or `ConsumerStatefulWidget` if controllers stay | high |
| In-place collection mutation | Riverpod 3.0 filters with `==`; `state.add(x)` then `state = state` does not rebuild | high |
| `setState` call sites | Replaced by assigning `state` inside the `Notifier` | high |
| `initState` | Moves into `Notifier.build()`, which can run more than once | medium |
| `dispose` | Moves to `ref.onDispose` for provider-owned resources only | medium |
| State lifetime | Generated providers auto-dispose by default; hand-written ones do not | medium |
| `context` after an `await` | `context.mounted` inside the widget becomes `ref.mounted` inside the notifier | medium |
| Widget tests | `pumpWidget` needs a `ProviderScope` wrapper or every read throws | low |

## Pre-flight checklist

1. Flutter 3.44 stable and Dart 3.x on the machine and in CI (`flutter --version`).
2. `flutter_riverpod: ^3.3.2` in `pubspec.yaml`, and `ProviderScope` wrapping `runApp`. If you are still on 2.x, do that upgrade first and separately: see [migrating from Riverpod 2.x to Riverpod 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/).
3. Decide codegen or no codegen now, not halfway through. Codegen needs `riverpod_annotation: ^4.0.3` plus `riverpod_generator: ^4.0.4` and `build_runner` under `dev_dependencies`.
4. `riverpod_lint` and `custom_lint` enabled in `analysis_options.yaml`. It catches `ref.read` in a `build` method, which is the single most common mistake in this migration.
5. A widget test that pins the current behaviour of the screen before you touch it. You want a red/green signal, not a vibe.
6. A branch. This is reversible, but not in three small commits.

## The starting point

A cart screen holding everything in `State`, with a callback drilled into a child so the badge can update:

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## Migration steps

1. **Classify every field in the `State` object.** Split them into two lists on paper before writing code. Domain state that another widget could plausibly need (`_lines`, `_isSubmitting`) moves to the notifier. Framework objects tied to this widget's element (`_couponController`, focus nodes, animation controllers, form keys) stay. *Verify:* every field is in exactly one list, and nothing in the "stays" list is read by another route.

2. **Model the state as one immutable value.** Two loose fields become one class so a single `state =` assignment describes the whole screen. *Verify:* `dart analyze` is clean and the class has `copyWith`.

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **Write the `Notifier`.** `build()` returns the initial state and replaces `initState`. Each former `setState` closure becomes a public method that assigns `state`. *Verify:* the file compiles with no reference to `BuildContext`, `setState`, or any widget type.

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   The code-generation form is the same class with the provider inferred:

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **Unit-test the notifier before touching a single widget.** This is the payoff, so collect it early. *Verify:* `flutter test test/cart_notifier_test.dart` passes with no widget pumped.

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **Convert the widget.** If nothing from step 1 stayed behind, `StatefulWidget` collapses to `ConsumerWidget` and `build` gains a `WidgetRef`. Because the coupon controller stayed, this screen becomes a `ConsumerStatefulWidget` instead. *Verify:* `flutter analyze` reports zero issues, including the `riverpod_lint` rules.

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **Apply the watch/read rule at every call site.** `ref.watch` in `build` because you want rebuilds. `ref.read(provider.notifier)` in callbacks because you do not. Never `ref.watch` inside an `onPressed`. *Verify:* grep the file for `ref.read(` and confirm every hit is inside a callback or an async method, never in `build`.

7. **Delete the drilled callbacks and let the other widget watch directly.** This is the step that pays for the migration. The badge stops receiving a count through three constructors and reads the provider itself. *Verify:* the intermediate widgets no longer declare the removed parameters, and adding an item from the cart screen updates the badge on another route.

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   `select` matters here. Without it the badge rebuilds whenever `isSubmitting` flips, which under `setState` it never did because it was not in that widget's subtree at all.

8. **Move provider-owned cleanup to `ref.onDispose`.** Anything the notifier created (a `StreamSubscription`, a timer, a socket) is released there, not in the widget's `dispose`. *Verify:* toggle the screen off and on and confirm no duplicate subscriptions in the logs.

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## Verification

Run this list before you merge:

- `flutter analyze` reports zero issues with `riverpod_lint` enabled.
- `flutter test` passes, and the widget tests now wrap the screen in a `ProviderScope`. Without it, the first `ref.watch` throws at runtime rather than at compile time.
- The screen builds and every former `setState` interaction still updates the UI. Tap through each one; the `==` filtering failure mode (see below) produces no error, just a frozen widget.
- Push the screen, pop it, push it again. Confirm the state persistence matches what you intended, not what happened by accident.
- Profile-mode check with DevTools: the rebuild count on the parent should be the same or lower than before. If it went up, you are missing a `select`.

## Rollback plan

This migration is reversible with `git revert` as long as you kept it on its own branch, because nothing changes on disk or over the wire. The one thing revert does not restore is behaviour that depended on the new lifetime: if you shipped and users grew accustomed to a cart surviving a back navigation, reverting to widget-local state silently drops it on pop. Roll back the code and re-test the navigation flows, not just the build.

## Gotchas we hit

**In-place mutation stopped rebuilding.** Under `setState`, `_lines.add(line)` inside the closure worked, because `setState` marks the element dirty regardless of what changed. Riverpod 3.0 compares the old and new state with `==` and skips notification when they are equal, so this does nothing at all:

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

Always build a new value, as step 3 does. This is the same equality filtering that catches people out when [a Riverpod 3.0 StreamProvider stops emitting](/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). It bites harder here if your state class uses `equatable` or a `freezed` value type, because then even a correctly rebuilt object with unchanged contents will be filtered.

**`build()` is not `initState`.** `initState` runs once per element. `Notifier.build()` re-runs whenever a watched dependency changes, and it resets `state` to whatever it returns. If you `ref.watch(authProvider)` inside `build()`, a token refresh wipes the cart. Use `ref.read` for values you only want at initialization, and reserve `ref.watch` in `build()` for dependencies that genuinely should reset the state.

**Auto-disposal defaults differ between the two syntaxes.** A hand-written `NotifierProvider(CartNotifier.new)` is kept alive by default; you opt in with `isAutoDispose: true`. A generated `@riverpod` provider is auto-disposed by default; you opt out with `@Riverpod(keepAlive: true)`. Teams that write both forms in one codebase get a cart that empties itself on some screens and not others, with no error to explain it.

**`mounted` moved.** Inside the widget you still use `context.mounted` and the usual [`mounted` guard after an async gap](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Inside the notifier there is no `BuildContext`, so the check is [`ref.mounted` after the await](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/). Forgetting it throws when the provider was disposed while the request was in flight.

**Controllers do not belong in the notifier.** Putting a `TextEditingController` in provider state looks tidy until the provider outlives the widget and you are typing into a controller whose listeners are gone. Keep the [controller disposal rules](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) exactly where they were.

## Related

- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) if you are still choosing a destination.
- [Migrate from Riverpod 2.x to Riverpod 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), the upgrade to do before this one.
- [Migrate from FutureBuilder to a Riverpod AsyncNotifier](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) for the async equivalent of this migration.
- [Which Riverpod package do you actually need](/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/), because `riverpod` and `flutter_riverpod` are not interchangeable.
- [Showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) once the notifier starts doing IO.

## Sources

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) for the unified `Ref`, `ref.mounted`, `ProviderContainer.test()`, and the `==` notification filtering.
- [Riverpod providers reference](https://riverpod.dev/docs/concepts2/providers) for the `Notifier` and `build()` contract.
- [Riverpod automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose) for `isAutoDispose` and `ref.keepAlive()`.
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) for the `AutoDispose` interface removal.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) and [riverpod_generator on pub.dev](https://pub.dev/packages/riverpod_generator) for the 3.3.2 and 4.0.4 version pins.
- [Flutter release notes](https://docs.flutter.dev/release/release-notes) for the 3.44 stable baseline.
