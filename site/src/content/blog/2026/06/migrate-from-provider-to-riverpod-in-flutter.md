---
title: "Migrate from provider to Riverpod in Flutter (provider 6.1.5 to Riverpod 3.x)"
description: "A step-by-step migration from the provider package to Riverpod 3.x in a real Flutter app: ChangeNotifierProvider to Notifier, MultiProvider to ProviderScope, context.watch to ref.watch, ProxyProvider to ref.watch composition, plus the equality and lifecycle gotchas that bite. Tested on Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "provider"
  - "state-management"
  - "migration"
---

The short version: add `flutter_riverpod` alongside `provider`, wrap your app in a `ProviderScope` instead of a `MultiProvider`, and migrate one feature at a time starting from the leaves of your dependency tree. Each `ChangeNotifier` becomes a `Notifier` (or `AsyncNotifier` for async work), `context.watch<T>()` becomes `ref.watch(myProvider)`, `Provider.of` and `context.read` become `ref.read`, and every `ProxyProvider` collapses into a plain `ref.watch` of another provider. A small-to-medium app is a one-to-three-day job; the breaking part is not the syntax, it is that Riverpod compares state by equality and keeps providers alive differently than `provider` does. Tested on Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1, riverpod_annotation 2.6.1, and riverpod_generator 2.6.5.

The `provider` package (currently 6.1.5) has been the default answer for Flutter state management since 2019, and it still works. But its author, Remi Rousselet, wrote Riverpod specifically to fix `provider`'s structural problems: state read through `BuildContext` means a `ProviderNotFoundException` at runtime instead of a compile error, `ProxyProvider` nesting gets unreadable past two dependencies, and you cannot have two providers of the same type without `ValueKey` gymnastics. Riverpod keeps the mental model (a graph of objects that rebuild widgets when they change) and removes the `BuildContext` coupling. This guide is the mechanical, leaf-first migration that does not require a rewrite.

## Why migrate off provider

- **Compile-time safety instead of `ProviderNotFoundException`.** In `provider`, reading a type that is not above you in the tree throws at runtime. In Riverpod, providers are top-level globals, so a typo is a compile error and there is nothing to "find."
- **No more `MultiProvider` pyramid.** Riverpod has no provider tree to assemble. One `ProviderScope` at the root replaces the entire `MultiProvider(providers: [...])` list, and dependencies between providers are expressed with `ref.watch`, not nesting order.
- **Two providers of the same type, for free.** `provider` keys everything by type, so two `ChangeNotifierProvider<CartModel>` collide. Riverpod keys by the provider object, so this is a non-issue.
- **Auto-dispose and family that actually compose.** Riverpod gives you `autoDispose` and parameterised (`family`) providers as first-class features, which `provider` only approximates with manual `ChangeNotifierProvider.value` and key management.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Root wiring | `MultiProvider` replaced by a single `ProviderScope` | medium |
| Reads | `context.watch<T>()` / `Provider.of<T>(context)` replaced by `ref.watch` / `ref.read` | high |
| Notifiers | `ChangeNotifier` + `notifyListeners()` replaced by `Notifier` + state reassignment | high |
| Rebuild semantics | Riverpod compares state by `==`; in-place mutation no longer rebuilds | high |
| Composition | `ProxyProvider` replaced by `ref.watch` of the dependency | medium |
| Widgets | `StatelessWidget` / `StatefulWidget` become `ConsumerWidget` / `ConsumerStatefulWidget` | medium |
| Lifecycle | `provider` disposes when removed from the tree; Riverpod keeps state until `autoDispose` | medium |

The two `high` rows in the rebuild and notifier areas are where teams lose time. Everything else is find-and-replace.

## Pre-flight checklist

- Flutter 3.27.1 / Dart 3.11 (or newer) installed: `flutter --version`.
- A clean `git` working tree and a branch you can throw away.
- An inventory of every provider you register today. Grep your codebase: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`.
- A note next to each one of whether anything depends on it. Migrate the things nothing depends on first.
- A working test suite, even a thin one. You will run it after every step.

## Migration steps

1. **Add Riverpod next to provider in `pubspec.yaml`.** Do not remove `provider` yet. Both packages coexist because they own separate trees; a given piece of state has exactly one owner at a time, so migrate per feature, not per type.

   ```yaml
   # pubspec.yaml. Flutter 3.27.1, Dart 3.11.
   dependencies:
     flutter:
       sdk: flutter
     provider: ^6.1.5            # keep until migration is done
     flutter_riverpod: ^3.3.1
     riverpod_annotation: ^2.6.1

   dev_dependencies:
     build_runner: ^2.4.13
     riverpod_generator: ^2.6.5
     custom_lint: ^0.7.0
     riverpod_lint: ^2.6.5
   ```

   Verify: `flutter pub get` resolves with no version conflicts.

2. **Wrap the app root in `ProviderScope` and keep `MultiProvider` inside it for now.** `ProviderScope` is where Riverpod stores all provider state. It is not a list of providers, it is a single boundary. Leave your existing `MultiProvider` underneath it so un-migrated screens keep working.

   ```dart
   // lib/main.dart, Flutter 3.27.1
   import 'package:flutter/material.dart';
   import 'package:flutter_riverpod/flutter_riverpod.dart';
   import 'package:provider/provider.dart';

   void main() {
     runApp(
       ProviderScope(                       // Riverpod root
         child: MultiProvider(              // legacy, shrinks as you migrate
           providers: [
             ChangeNotifierProvider(create: (_) => CartModel()),
             ChangeNotifierProvider(create: (_) => AuthModel()),
           ],
           child: const MyApp(),
         ),
       ),
     );
   }
   ```

   Verify: the app still builds and runs identically. Nothing has moved yet.

3. **Convert one leaf `ChangeNotifier` into a `Notifier`.** Pick a model nothing else depends on. In `provider` you mutate a field and call `notifyListeners()`. In Riverpod, `build()` returns the initial state and you reassign `state` to notify. There is no `notifyListeners()`.

   ```dart
   // Before: provider 6.1.5
   class CartModel extends ChangeNotifier {
     final List<Item> _items = [];
     List<Item> get items => List.unmodifiable(_items);

     void add(Item item) {
       _items.add(item);
       notifyListeners();
     }
   }
   ```

   ```dart
   // After: flutter_riverpod 3.3.1, code generation
   import 'package:riverpod_annotation/riverpod_annotation.dart';

   part 'cart_model.g.dart';

   @riverpod
   class Cart extends _$Cart {
     @override
     List<Item> build() => const [];

     void add(Item item) {
       state = [...state, item];   // new list, not state.add(...)
     }
   }
   ```

   Run `dart run build_runner build --delete-conflicting-outputs` to generate `cartProvider`. Verify: the generator produces `cart_model.g.dart` with no errors.

4. **Switch the screen that consumes it to a `ConsumerWidget`.** `StatelessWidget` becomes `ConsumerWidget` and `build` gains a `WidgetRef ref`. `context.watch<CartModel>()` becomes `ref.watch(cartProvider)`. For a method call, `context.read<CartModel>().add(x)` becomes `ref.read(cartProvider.notifier).add(x)`.

   ```dart
   // Before
   class CartView extends StatelessWidget {
     @override
     Widget build(BuildContext context) {
       final items = context.watch<CartModel>().items;
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => context.read<CartModel>().add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ```dart
   // After
   class CartView extends ConsumerWidget {
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final items = ref.watch(cartProvider);
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => ref.read(cartProvider.notifier).add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   If the widget already had its own state, use `ConsumerStatefulWidget` plus `ConsumerState`, where `ref` is available as a field. Remove the `ChangeNotifierProvider(create: (_) => CartModel())` line from `MultiProvider`. Verify: the screen behaves the same and the `MultiProvider` list is one shorter.

5. **Replace `ProxyProvider` with `ref.watch` composition.** This is the step that deletes the most code. A `ProxyProvider` that builds B from A becomes a provider that simply watches A.

   ```dart
   // Before: ProxyProvider wiring
   ProxyProvider<AuthModel, ApiClient>(
     update: (_, auth, __) => ApiClient(token: auth.token),
   ),
   ```

   ```dart
   // After: a provider that watches its dependency
   @riverpod
   ApiClient apiClient(ApiClientRef ref) {
     final token = ref.watch(authProvider.select((a) => a.token));
     return ApiClient(token: token);
   }
   ```

   `ref.watch(...select(...))` is the direct replacement for `provider`'s `context.select`, and it means `apiClient` only rebuilds when `token` changes, not on every `AuthModel` update. Verify: dependent widgets rebuild when the upstream provider changes.

6. **Migrate `FutureProvider` and `StreamProvider` to their Riverpod equivalents.** The names are the same; only the wiring differs. A `provider` `FutureProvider` is read with `context.watch<AsyncSnapshot>`-style plumbing; the Riverpod one returns an `AsyncValue<T>` you switch on directly.

   ```dart
   // After: flutter_riverpod 3.3.1
   @riverpod
   Future<User> currentUser(CurrentUserRef ref) {
     return ref.watch(apiClientProvider).fetchUser();
   }

   // in a ConsumerWidget
   final userAsync = ref.watch(currentUserProvider);
   return userAsync.when(
     data: (user) => Text(user.name),
     loading: () => const CircularProgressIndicator(),
     error: (e, _) => Text('Failed: $e'),
   );
   ```

   Verify: loading and error states render without manual `bool isLoading` flags. For more on this pattern, see the linked AsyncValue post below.

7. **Delete the `provider` dependency.** Once `MultiProvider` is empty, remove it from `main.dart`, then drop `provider: ^6.1.5` from `pubspec.yaml` and run `flutter pub get`. The compiler will flag any remaining `context.watch`/`context.read`/`Provider.of` calls. Verify: the project compiles with zero references to `package:provider`.

## Verification

Run this checklist after the last step, not just at the end:

- `flutter analyze` reports no errors and no `riverpod_lint` warnings.
- `dart run build_runner build --delete-conflicting-outputs` completes clean.
- `flutter test` passes. Riverpod tests use `ProviderContainer` (or `ProviderContainer.test()` in 3.x) and `container.read(provider)`, replacing your old `ChangeNotifier` unit tests.
- A manual smoke pass: every migrated screen still rebuilds on state change, and no screen throws `ProviderNotFoundException` (there should be none left, by construction).
- `grep -rn "package:provider" lib/` returns nothing.

## Rollback plan

This migration is reversible per feature precisely because both packages coexist. If a migrated screen misbehaves, revert that screen's commit: put the `ChangeNotifierProvider` line back in `MultiProvider`, restore the `ChangeNotifier` class, and change the widget back to `StatelessWidget`. Because you migrated leaf-first and one feature per commit, no rollback touches more than one screen. Do not delete `provider` from `pubspec.yaml` (step 7) until you are confident, since that is the only one-way door in the sequence.

## Gotchas we hit

**In-place mutation stops rebuilding.** This is the number one surprise. In `provider`, `_items.add(x); notifyListeners()` works because you control the notification. In a Riverpod `Notifier`, the framework rebuilds only when `state` is assigned a value that is not `==` to the old one. `state.add(x)` mutates the same list, the reference is unchanged, and nothing rebuilds. Always assign a new collection: `state = [...state, x]`. The same applies to model objects, which is why immutable state (records, `copyWith`, or a `freezed` class) pairs naturally with Riverpod.

**Providers do not dispose when the widget leaves the tree.** A `provider` `ChangeNotifierProvider` is disposed when its subtree is removed. A Riverpod provider, by default, keeps its state for the life of the `ProviderScope`. If you relied on a screen's controller resetting when you navigate away, you now need `autoDispose` (or, with code generation, that is the default for annotated providers unless you call `ref.keepAlive()`). Audit any provider whose old behaviour depended on tree-based disposal.

**`ref.read` inside `build()` is a trap.** Reading another provider with `ref.read` inside a `Notifier.build()` or a widget `build` snapshots the value once and never updates. Use `ref.watch` for anything that should react, and reserve `ref.read` for event handlers like button callbacks. `riverpod_lint` flags most of these for you, which is why the dev dependency is worth installing on day one.

**`Consumer` exists in both packages.** If you import both during the migration, `Consumer` is ambiguous. Riverpod's `Consumer` takes a `(context, ref, child)` builder; `provider`'s takes `(context, value, child)`. Prefer converting the whole widget to `ConsumerWidget` rather than dropping a Riverpod `Consumer` into a provider-era widget, and you will avoid the import clash entirely.

The migration rewards being boring: one leaf, one commit, run the tests, repeat. By the time you delete `provider` from `pubspec.yaml`, the risky part happened weeks ago in small, reversible steps.

## Related

- If you are coming from a different state library, the [GetX to Riverpod migration](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) covers the same leaf-first approach for a heavier framework.
- Still deciding? The [provider vs Riverpod vs Bloc comparison](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) lays out the tradeoffs before you commit.
- For the async side, [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) goes deep on `when` and `AsyncNotifier`.
- Coming from raw `FutureBuilder`? See [FutureBuilder/StreamBuilder vs Riverpod AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).
- The most common runtime error after migrating: [Cannot use ref after the widget was disposed](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Sources

- [Riverpod docs: migrating from pkg:provider (quickstart)](https://riverpod.dev/docs/from_provider/quickstart)
- [Riverpod docs: from ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Riverpod docs: what's new in 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 on pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [flutter_riverpod changelog](https://pub.dev/packages/flutter_riverpod/changelog)
