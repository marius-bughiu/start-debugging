---
title: "Fix: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "This crash means you read a late field before anything assigned it. Initialize it synchronously in initState, or stop using late and model the async value as nullable state."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

A `late` field was read before any code assigned it a value. The field has no initializer expression, so Dart cannot lazily compute it, and the read happened before the assignment you intended. The most common cause in Flutter is a `late` field that you assign from an async method (a network fetch, a database read) while `build()` runs first and touches the field before the future completes. The fix depends on timing: if the value is available synchronously, assign it in `initState()` before the first build; if it only arrives later, do not use `late` at all -- declare the field nullable (`Type?`) and render a loading state until it is set. This guide uses Flutter 3.44 (stable, May 2026) and Dart 3.x. The `late` modifier itself has been around since Dart 2.12.

## The error in context

The full message Dart throws looks like this:

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

The frame at the top, the synthetic `_user` getter, is the read that failed. The frame just below it, here `build`, is the line in your code that touched the field. That line is where the crash surfaces, but the bug is the absence of an assignment that should have run before it. `LateInitializationError` is a subtype of `Error`, not `Exception`, which is Dart's way of telling you this is a programming mistake, not a recoverable runtime condition. You fix the control flow; you do not catch it.

The message has three close cousins, and the wording tells you which one you hit:

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" means an instance or static field; "Local" means a local variable inside a function. "has already been initialized" is the opposite mistake: assigning a `late final` field twice. They share a root cause family but not the same fix, and the variants section below covers the others.

## Why this happens

There are four causes, in rough order of how often they bite.

The value is assigned asynchronously but read synchronously. You declared `late User _user;` and assign it inside an `async` method that you kick off from `initState()`. But `initState()` returns immediately, the first `build()` runs while the fetch is still in flight, and `build()` reads `_user`. Nothing has assigned it yet, so the read throws. This is by far the most common shape of the bug, and it is insidious because it is a guaranteed crash, not a flaky one: the future never completes before the first frame, so it fails every time the screen opens.

The assignment lives on a branch that did not run. You wrote `late String _label;` and only assign it inside an `if` or a `switch` arm. When the condition is false or no arm matches, the field stays unassigned, and the next read throws. The Dart compiler accepts this because `late` is a promise from you to the analyzer that you will assign before reading; the analyzer stops checking definite assignment and trusts you.

You forgot the assignment entirely. The field was declared `late` during a refactor, the line that set it was deleted or never written, and the analyzer said nothing because `late` opts out of the definite-assignment check. This is the case where the fix is simply to assign the thing.

The field needs `InheritedWidget` data and you assigned it too early. If the value comes from `Theme.of(context)`, `MediaQuery.of(context)`, a `Provider`, or any `InheritedWidget`, you cannot read it in the constructor or in field initializers, because the element is not yet mounted in the tree. Assigning in `initState()` is also too early for inherited data. The right hook is `didChangeDependencies()`, and getting this wrong leaves the `late` field unassigned at first build.

The underlying contract, from the Dart language docs on the [`late` modifier](https://dart.dev/language/variables#late-variables): a `late` field without an initializer must be assigned before it is read, and reading it first is a runtime error. A `late` field with an initializer is different: the initializer runs lazily on first read, so it can never be "not initialized". That distinction is the key to the cleanest fixes below.

## A minimal repro

This screen crashes every time it opens. It compiles without a warning.

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

The sequence is: `initState()` runs and starts `_load()`, `_load()` hits its first `await` and yields, Flutter proceeds to the first `build()`, `build()` reads `_user`, and nothing has assigned it yet. The `setState(() => _user = fetched)` that would have set it runs 300ms later. The first frame loses the race every time.

## Fix, in detail

The fixes are ordered by how much I recommend them. Pick the one that matches your cause.

### 1. If the value is async, do not use late -- model it as nullable state (recommended)

`late` is the wrong tool for a value that arrives after the first build. It promises the value is ready synchronously; an awaited fetch is not. Declare the field nullable and render a loading state while it is null. Now the type system forces you to handle "not loaded yet" instead of crashing on it.

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

The `if (!mounted) return;` guard before `setState` is not optional here: an async callback that resolves after the user left the screen will otherwise throw a different error. That guard is the same discipline you need for [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), and it travels with every awaited callback in a `State`.

For anything beyond a single value, prefer a `FutureBuilder` or, if you are on Riverpod, an `AsyncValue` that encodes loading, error, and data as three explicit cases. Writing the result straight into a field after an await is exactly the pattern that produces this crash and its disposal-time siblings; modelling the request as state instead is covered in [showing loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 2. If the value is synchronous, assign it in initState before the first build

`late` is correct when the value is genuinely available before build but you cannot compute it in the field initializer (for example, it needs `widget`). Assign it in `initState()`, which runs once before the first `build()`.

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

This is the legitimate use of `late final` in a `State`: you need `widget.initialText`, which is not available in a field initializer, but it is available in `initState()`, which still runs before any build. Because the controller is created exactly once and never reassigned, `late final` is the right modifier, and you still owe it a `dispose()`, as the [controller-disposal guide](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) lays out.

### 3. Use a lazy initializer so the field can never be unassigned

If the value can be computed on demand and does not depend on `widget` or `context`, give the `late` field an initializer expression. Dart then runs that expression lazily on first read, so the field initializes itself the first time anyone touches it. A `late` field with an initializer cannot throw "has not been initialized".

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

This is the one case where `late` earns its keep purely for performance: the work is deferred until needed and skipped entirely if `histogram` is never read. If the initializer is cheap, drop `late` and initialize at declaration instead; lazy initialization is only worth the modifier when the computation is expensive or has side effects you want to defer.

### 4. Read InheritedWidget data in didChangeDependencies, not earlier

If the `late` field is fed by `Theme.of`, `MediaQuery.of`, or a provider, move the assignment to `didChangeDependencies()`. It runs after `initState()` and again whenever an inherited dependency changes, and it is the earliest point where `context` can safely resolve inherited widgets.

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

Doing this in `initState()` either throws (older Flutter) or returns stale data that never updates when the theme changes. `didChangeDependencies()` fixes both: the field is assigned before the first build and reassigned whenever the theme does.

## Gotchas and variants

`LateInitializationError: Field '...' has already been initialized.` The mirror image. You assigned a `late final` field twice. `late final` permits exactly one write; the second throws this. It usually happens when `initState()` assigns the field and a later code path (a `didUpdateWidget`, a callback, a second `_load`) assigns it again. If you genuinely need to reassign, drop `final` and keep just `late`; if you do not, find the duplicate write and delete it.

`LateInitializationError: Local '...' has not been initialized.` Same error on a local variable instead of a field. You wrote `late int total;` inside a function and a branch left it unassigned before a read. Local `late` is rarely worth it: prefer initializing the variable at its declaration, or restructure so every path assigns it before use. The analyzer's definite-assignment check would have caught this for you if the variable were not `late` -- that check is precisely what `late` turns off.

It throws in release but the message is gone. In release builds the assertion machinery is trimmed, but a `late`-without-initializer read still throws `LateInitializationError`; only the rich debug message is reduced. Do not assume `late` crashes are debug-only. They ship.

`late` versus the null-check operator. Reaching for `late` to silence "the non-nullable field must be initialized" is the same instinct that makes people sprinkle `!` to silence nullability. Both defer a compile-time guarantee to a runtime crash. If a value can legitimately be absent, model it as nullable and handle the null; `late` is only for values that are always present but assigned slightly after declaration. The broader null-safety mental model, including when `late` is and is not the right escape hatch, is in the [Flutter 2 to 3.x null-safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

A `late` field read inside its own initializer. If a lazy `late final x = ...x...;` initializer reads `x`, you get a `LateInitializationError` about reading during initialization. The cycle is the bug; break it by computing the value without referencing the field.

The single discipline that removes this whole class of bug: use `late` only for a value that is always present and assigned synchronously before the first read (typically in `initState()` or `didChangeDependencies()`), and model anything that arrives asynchronously as nullable state with an explicit loading branch. Wire that distinction into your reflex and the error stops appearing. The moment you find yourself assigning a `late` field after an `await`, that is the signal to switch it to `Type?` and render the in-between state instead.

## Related

- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) covers the `mounted` guard the async fix above depends on.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) is the structured alternative to writing async results into a `late` field.
- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) is the other half of the controller lifecycle that `late final` controllers participate in.
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) pairs with the `late final TextEditingController` pattern in fix 2.
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) explains where `late` fits in null safety and where nullable types are the better call.

## Sources

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- the contract for `late` fields with and without initializers.
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- the rationale for `late` and how it interacts with definite assignment.
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- which lifecycle hook can safely read inherited data.
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- the error type and what triggers it.
