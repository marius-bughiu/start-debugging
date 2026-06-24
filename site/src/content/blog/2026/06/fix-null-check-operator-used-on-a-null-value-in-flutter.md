---
title: "Fix: Null check operator used on a null value in Flutter"
description: "The ! operator hit a null at runtime. Replace it with ?. and ?? for a safe default, or guard with an explicit null check, instead of asserting a value that was not there."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
---

You wrote `something!` and `something` was `null` when the line ran. The null check (bang) operator promises the compiler "this is never null", and Dart enforces that promise at runtime by throwing the instant the promise is broken. The fix is almost always to stop asserting and start handling: use `?.` to short-circuit, `??` to supply a default, or an `if (x != null)` guard that lets the compiler narrow the type for you. This page uses Flutter 3.44 (stable, May 2026) and Dart 3.x.

## The error in context

When the bang operator hits a `null`, you get a `TypeError` with this exact message:

```
Unhandled Exception: Null check operator used on a null value
```

In the widget layer it usually surfaces wrapped by the framework, which is where most people actually see it:

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

The class is `_TypeError` (a subtype of `TypeError`), the same family Dart uses for failed casts. That is the tell: the bang operator is a cast. It casts `T?` to `T`, and like any cast it can fail at runtime.

## Why this happens: the bang operator is a checked cast

In sound null safety, `String?` and `String` are different types. The postfix `!` is shorthand that, in the words of the Dart docs, "takes the expression on the left and casts it to its underlying non-nullable type." A cast from a nullable type to a non-nullable one cannot be proven safe at compile time, so the compiler inserts a runtime check. If the value is `null` when the check runs, you get `Null check operator used on a null value`.

So this is never a compiler bug and never a framework bug. It is a value being `null` at a moment when your code swore it would not be. The job is to find the value and decide what should happen when it is genuinely absent, rather than papering over it with another `!`.

## Minimal repro

The smallest version is a single nullable variable that has not been assigned yet:

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

In real Flutter code the most common shape is data that has not loaded yet. The field is `null` until a network call fills it, but `build` runs immediately and dereferences it:

```dart
// Flutter 3.44, Dart 3.x -- crashes on first build
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  User? _user; // null until the fetch returns

  @override
  void initState() {
    super.initState();
    _loadUser(); // async, completes some frames later
  }

  Future<void> _loadUser() async {
    final u = await api.fetchUser();
    setState(() => _user = u);
  }

  @override
  Widget build(BuildContext context) {
    return Text(_user!.name); // <-- _user is null on the first build
  }
}
```

`build` is called before `_loadUser` resolves, so `_user` is still `null` on the first frame and `_user!` throws.

## Fix, in order of preference

The right fix depends on whether `null` is a legitimate state (data still loading, optional field, key not present) or a bug (you expected a value and its absence means something upstream is broken). Most of the time it is the former, and the framework gives you idiomatic tools for it.

### 1. Provide a default with `??`

If a sensible fallback exists, the null-coalescing operator is the shortest correct fix. It returns the right-hand side when the left is `null`:

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` is `null` when `_user` is `null` (the `?.` short-circuits the whole chain), and `??` substitutes the placeholder. No throw, and the UI says something useful while data loads.

### 2. Branch on the loading state explicitly

When there is no good default, render different widgets for the loaded and not-yet-loaded states. An `if (x != null)` check promotes the local to non-nullable inside the branch, so you do not need `!` at all:

```dart
// Flutter 3.44, Dart 3.x
@override
Widget build(BuildContext context) {
  final user = _user;            // copy to a local for promotion
  if (user == null) {
    return const Center(child: CircularProgressIndicator());
  }
  return Text(user.name);        // user is User here, not User?
}
```

Copy the field into a local first. Dart only promotes locals, not instance fields, because another method (or another isolate) could mutate a field between the check and the use. The local is the load-bearing part of this pattern.

### 3. Let `FutureBuilder` own the null state

If the value comes from a single async call, do not hand-roll the flag. `FutureBuilder` models loading, error, and data as one object, and you only read `data` once you have confirmed it is present:

```dart
// Flutter 3.44, Dart 3.x
FutureBuilder<User>(
  future: _userFuture, // created once, not in build -- see below
  builder: (context, snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return const CircularProgressIndicator();
    }
    if (snapshot.hasError) {
      return Text('Failed: ${snapshot.error}');
    }
    return Text(snapshot.data!.name); // safe: hasData is implied here
  },
);
```

The `snapshot.data!` here is legitimate because you have already proven the future completed without error. One caveat that bites people: create the future once and store it, never inline in `build`, or every rebuild starts a new fetch. That is its own footgun covered in [why FutureBuilder keeps recreating its Future](/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

### 4. Use `late` only when initialization truly precedes the first read

If a value is assigned exactly once, before anything reads it, `late` removes the nullability without the bang. But this is a trade, not a free win: a `late` field read before assignment throws `LateInitializationError`, a different and arguably worse crash because it is easy to assume `late` made the value safe. Reach for it only when the ordering is guaranteed, for example a value set in `initState` and read in `build`:

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

If the ordering is not guaranteed, keep the field nullable and guard it. The full breakdown of when `late` helps versus hurts is in [fixing LateInitializationError in Flutter](/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

## The usual suspects beyond a loading flag

The error wears several costumes. These are the high-frequency ones, each with the same underlying cause and the same shape of fix.

**`GlobalKey.currentState!` before the widget is mounted.** Calling `_formKey.currentState!.validate()` when the `Form` is not in the tree (or not built yet) throws, because `currentState` is `null` until the widget attaches. Use `?.`:

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**Route arguments that were not passed.** `ModalRoute.of(context)!.settings.arguments as Args` assumes both that a route exists and that arguments were supplied. If you push the route without arguments, `arguments` is `null` and the later `as` or a subsequent `!` blows up. Read it defensively:

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**Map and JSON access with `[key]!`.** A map lookup returns `null` for a missing key, and `json['email']!` throws the moment the field is absent or the API renamed it. Decode through a model with explicit nullability or default each field:

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**`firstWhere` with a bang on the result.** People sometimes write `list.firstWhere((e) => e.id == id, orElse: () => null)!` to "find or crash". That is exactly an unchecked assumption. Prefer `firstWhereOrNull` from `package:collection` and handle the empty case:

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## Variants this is not, and where to go instead

Search traffic for this error often belongs on a neighbouring page. Three lookalikes:

`LateInitializationError: Field '_x' has not been initialized` is a sibling, not the same error. It comes from reading a `late` variable before assignment, not from a `!` on a nullable. If your stack trace says `LateInitializationError`, the fix is on [the LateInitializationError page](/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/), not here.

A null check that only fails after navigation, and only in release, is often a dead-context symptom. The deactivated-context lookup returns `null` in release builds (the assert that catches it is debug-only), and the `null` then trips a `!` somewhere downstream. If the crash correlates with an `await` followed by a context use, read [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), because the real bug is upstream of the bang.

A `TextEditingController` or other controller used after `dispose` can also feed a `null` into a later assertion. If the controller is the source, [fixing the disposed-controller error](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter) addresses the lifecycle directly.

## The lint that catches this before runtime

Dart cannot warn on every `!` that might fail, because that is the whole point of the operator: you are overriding the analyzer. But it can flag the ones it can prove are pointless. The `unnecessary_non_null_assertion` rule, on by default in `flutter_lints`, fires when you bang a value the analyzer already knows is non-null, which usually means your mental model and the type system disagree:

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

The broader discipline is to treat every `!` you type as a claim you have to defend. If you cannot point to the line that guarantees the value is non-null on that path, you do not have a `!`, you have a latent `Null check operator used on a null value`. Modelling async data as explicit loading and error states, as in [loading and error states with AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), removes most of these claims entirely, because the framework hands you the value only on the branch where it exists.

## The habit that retires the bug

The bang operator is a promise to the compiler, redeemed at runtime, and `Null check operator used on a null value` is the receipt for a broken promise. Whenever you are tempted to write `!`, ask what should happen when the value is actually `null`: a placeholder (`??`), a different widget (`if (x != null)`), or a real error you surface on purpose. Pick one of those and the crash never reaches a user. Reserve `!` for the rare case where `null` would be a genuine invariant violation, and even then, prefer a thrown `StateError` with a message that explains what went wrong over a bare bang that says only "this was null".

## Sources

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety), Dart docs, which defines the `!` operator as a checked cast to the non-nullable type and explains why the check must run at runtime.
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety), Dart language documentation.
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion), Dart linter rules.
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html), `package:collection` API docs.
