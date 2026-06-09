---
title: "How to Initialize a Future So FutureBuilder Doesn't Recreate It on Every Rebuild in Flutter"
description: "FutureBuilder re-runs your async work every time the parent rebuilds because you created the Future inside build. Hoist it into State.initState (or memoize it), and FutureBuilder will reuse the same Future. Here is the why, the repro, and every variant that bites."
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
---

If your `FutureBuilder` flickers back to its loading spinner, re-fetches data, or fires the same network call several times, the cause is almost always that you created the `Future` inside `build`. Every rebuild of the surrounding widget then calls `build` again, constructs a brand-new `Future`, and `FutureBuilder` dutifully restarts. The fix is to create the `Future` exactly once, store it in a field on your `State`, and pass that stored field to `FutureBuilder`. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

The Flutter team is explicit about this in the [FutureBuilder API docs](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): "The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." The reason follows immediately: "If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." That is the whole bug, stated by the framework itself.

## Why a fresh Future restarts the whole thing

`FutureBuilder` does not track "the operation you wanted to run." It tracks a specific `Future` object by identity. In `didUpdateWidget`, it compares `oldWidget.future` to the new `widget.future`. If they are not the same instance, it throws away the old subscription, resets its `AsyncSnapshot` to `ConnectionState.waiting` (or `none`), and subscribes to the new one. There is no value-based deduplication and no memoization built in. Identity is the only signal it has.

Now think about what `build` does. Calling `something()` that returns a `Future` produces a new `Future` instance on every invocation, even if the underlying work is identical. `Future.delayed(...)`, `http.get(...)`, `repository.load()` -- each call allocates a distinct object. So if the `future:` argument is an expression evaluated inside `build`, `FutureBuilder` sees a different identity every frame and concludes, correctly by its own rules, that you handed it a new task.

And `build` runs far more often than people expect. A parent `setState`, an inherited widget changing (`MediaQuery` on rotation, `Theme` on a brightness toggle), a `Scaffold` opening a keyboard, an ancestor animation, a hot reload -- any of these rebuilds your widget and re-evaluates the `future:` expression. The async work is not slow or broken. It is being thrown away and restarted from scratch every single time.

## A minimal repro that re-fetches on every rebuild

Here is the anti-pattern in its purest form. The `Future` is built inline in `build`, and a counter forces rebuilds so you can watch it misbehave.

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Tap the button. Each tap calls `setState`, which calls `build`, which calls `_loadName()` again, which returns a new two-second `Future`. The spinner comes back every tap. In a real app where `_loadName()` is an HTTP request, you have just turned one fetch into one-fetch-per-rebuild, and the user watches the screen flash white repeatedly. This is the same family of mistake as [calling setState during build](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/): doing work in `build` that `build` is not allowed to own.

## The fix, step by step

Move the `Future` out of `build` and into a field that is initialized exactly once.

1. **Convert the widget to a `StatefulWidget`** if it is not one already. A `StatelessWidget` has no `initState` and no place to durably hold a `Future`, so it cannot satisfy the "obtained earlier" rule. (More on the stateless case below.)
2. **Declare a `late final Future<T>` field** on the `State` class. `late final` lets you assign it in `initState` and guarantees it is written exactly once.
3. **Assign the field in `initState`**, calling your async method there instead of in `build`. `initState` runs a single time for the lifetime of the `State`, no matter how many times the widget rebuilds.
4. **Pass the stored field to `FutureBuilder`**, never an inline call. The `future:` argument becomes a plain field reference with no parentheses.
5. **Verify with a forced rebuild**: trigger `setState` repeatedly and confirm the spinner does not return and the work does not re-run.

Applied to the repro:

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Now the button increments the counter, `build` runs again, but `future: _nameFuture` points at the identical `Future` instance created back in `initState`. `FutureBuilder.didUpdateWidget` sees `oldWidget.future == widget.future`, keeps its existing subscription, and never resets the snapshot. The fetch happens once. This is the canonical pattern and it covers the large majority of real cases.

## When the Future depends on a widget parameter

The `initState` approach has one sharp edge: `initState` cannot see a new value of `widget`. If your `Future` depends on a `widget.userId` that the parent can change, initializing only in `initState` means the data goes stale when the parent passes a different id, because the `State` object is reused across that change.

The framework's own list of approved places already named the answer: `State.didUpdateWidget`. Re-create the `Future` there, but only when the relevant input actually changed, so you do not reintroduce the every-rebuild restart.

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

The guard `if (oldWidget.userId != widget.userId)` is the entire point. Without it you would refetch on every parent rebuild again, just one layer removed from the original bug. If your `Future` depends on an `InheritedWidget` (a value read via `context.dependOnInheritedWidgetOfExactType`, like a `Locale` or a provider scope), use `didChangeDependencies` with the same change-detection guard, since that is the callback Flutter fires when an inherited dependency changes.

## Forcing a deliberate refresh

Hoisting the `Future` into a field raises an obvious question: how do you reload on purpose, for example on pull-to-refresh? Reassign the field inside `setState`. That gives `FutureBuilder` a new identity exactly when you intend it.

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

This is the controlled version of the broken pattern: the new `Future` is created in response to a user action, not as a side effect of an unrelated rebuild. Pair it with a `RefreshIndicator` whose `onRefresh` returns the new future so the spinner stays up until the fetch resolves. While you are wiring refresh, decide how the builder renders a failed reload; the patterns in [handling network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) apply directly to the `snapshot.hasError` branch.

## Memoizing without writing initState boilerplate

If you maintain many of these and the `initState` plus `didUpdateWidget` ceremony grates, the `async` package's `AsyncMemoizer` collapses it: it runs a callback at most once and returns the same `Future` on subsequent calls, so even an inline call in `build` resolves to a single underlying operation.

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` executes its callback the first time and caches the resulting `Future`; later calls ignore the new callback and return the cached one. The memoizer still lives on the `State`, so it shares the same lifetime guarantees as a `late final` field. For the parameter-dependent case you would key a fresh memoizer per id, which is more bookkeeping than `didUpdateWidget`, so reach for `AsyncMemoizer` mainly when the operation has no inputs.

## Why a StatelessWidget can't fix this

A `StatelessWidget` has no `initState`, no `State`, and no stable place to stash a `Future`. Any field you add is recreated whenever the parent rebuilds the widget, because Flutter discards and reconstructs `StatelessWidget` instances freely. So the "create it earlier" rule is unsatisfiable in a `StatelessWidget`: the earliest you can create the `Future` is in `build`, which is exactly the place the docs forbid. If you find yourself wanting a long-lived `Future` inside a `StatelessWidget`, that is the signal to either promote it to a `StatefulWidget` or lift the `Future` into a state-management layer that outlives the widget entirely.

That second option is increasingly the idiomatic one. A Riverpod `FutureProvider` or `AsyncNotifier` caches its `Future` for you and only recomputes when a dependency changes, which removes the manual `initState` dance and survives widget rebuilds and even route changes. If you are choosing a long-term approach rather than patching one screen, the trade-offs are laid out in [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), and the three-state rendering you get from a provider's `AsyncValue` is covered in [showing loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Two related gotchas the field pattern does not solve

Hoisting the `Future` fixes the restart, but two adjacent issues survive it. First, a `FutureBuilder` inside a scrollable list that uses `AutomaticKeepAliveClientMixin` incorrectly can still rebuild when the row scrolls back into view; the `Future` field protects the data, but make sure the row state itself is kept alive if you want to avoid a rebuild flash. Second, a `Future` that completes after the widget is gone will try to deliver into a disposed `State`. `FutureBuilder` itself guards against `setState`-after-dispose internally, but if your async method touches other controllers when it resolves, you can still hit lifecycle errors. The disposal discipline in [disposing controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) is the companion habit: own every resource you create, and release it in `dispose`.

The mental model to keep: `FutureBuilder` is a thin adapter that watches one `Future` by identity. It is your job to make that identity stable. Create the `Future` in `initState`, refresh it in `didUpdateWidget` or `didChangeDependencies` only when an input changed, and reassign it in `setState` only when the user asked for fresh data. Do that and the spinner shows exactly once, the network is hit exactly once, and the screen stops flashing.

## Sources

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html) - the "must have been obtained earlier" rule and the restart warning, quoted above.
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html) - runs once per State lifetime.
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html) - the hook for reacting to changed widget configuration.
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html) - run a callback at most once.
