---
title: "Fix: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold (Flutter)"
description: "This error means the BuildContext you passed is above the Scaffold or ScaffoldMessenger, not below it. Wrap the caller in a Builder, extract it into its own widget, or use a GlobalKey."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` (and its older twin, `Scaffold.of() called with a context that does not contain a Scaffold`) means the `BuildContext` you handed to `.of()` sits *above* the `Scaffold` or `ScaffoldMessenger` it is trying to find, not below it. It almost always happens when you call it from the same `build` method that returns the `Scaffold`. Fix it by wrapping the caller in a `Builder`, extracting it into its own widget, or reaching the messenger through a `GlobalKey`. Tested on Flutter 3.x (3.44), Dart 3.x.

## The error in context

There are two closely related messages, and which one you get depends on which API you called. The classic one, from the pre-2.0 `Scaffold.of()` API that a lot of old Stack Overflow answers still use:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

The modern one, from `ScaffoldMessenger.of()`, which is the API you should be using to show a `SnackBar`:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

Both are the same bug wearing different clothes: an ancestor lookup that starts too high in the tree and walks the wrong direction. Understanding *why* the lookup fails is the difference between pasting a `Builder` in and hoping, and knowing exactly which fix your situation needs.

## Why the lookup starts in the wrong place

`ScaffoldMessenger.of(context)` and `Scaffold.of(context)` both do an ancestor walk. Internally they call `context.dependOnInheritedWidgetOfExactType` (through an inherited `_ScaffoldMessengerScope`), which starts at the element for `context` and climbs *upward* toward the root, looking for the nearest matching ancestor. It never looks downward.

Now picture the widget that fails. You wrote a `build` method that returns a `Scaffold`, and somewhere in that method you call `Scaffold.of(context)` or `ScaffoldMessenger.of(context)` using the `context` parameter of that same `build`. That `context` belongs to *your* widget's element. Your widget is the **parent** of the `Scaffold` it returns. So when the lookup climbs from your element, the `Scaffold` you just created is below the starting point, and the walk never reaches it. It sails past your widget and up into whatever is above you, finds nothing appropriate, and asserts.

That is the exact scenario the framework calls out in the classic message: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought."

There is one subtlety worth knowing, because it explains why you may or may not see the error. `MaterialApp` inserts a `ScaffoldMessenger` near the top of your tree for you. That means `ScaffoldMessenger.of(context)` usually succeeds *even from a context that has no Scaffold above it at all*, because it finds the app-level messenger. So the "No ScaffoldMessenger widget found" variant only fires when there genuinely is no messenger ancestor: you are above `MaterialApp`, you built the app with a bare `WidgetsApp` and no messenger, or you created a custom `ScaffoldMessenger` scope and are calling from outside it. The far more common failure in real code is the `Scaffold.of()` one, or a `SnackBar` that shows in the wrong place because you resolved the wrong messenger.

## The minimal repro

The smallest reliable trigger is a button placed directly in the `build` method that returns the `Scaffold`, calling `.of()` with that method's `context`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

Swap `Scaffold.of` for `ScaffoldMessenger.of` and, because `MaterialApp` provides a messenger, the crash disappears but the `SnackBar` is now managed by the root messenger rather than this screen's `Scaffold`. That is fine for most apps, and it is exactly why the migration to `ScaffoldMessenger` was made. But if you have nested `ScaffoldMessenger` scopes, you can still resolve the wrong one from the wrong context.

## Fix 1: use ScaffoldMessenger.of, not Scaffold.of

If your error is the `Scaffold.of()` variant and you are only trying to show, hide, or remove a `SnackBar`, the first and best fix is simply to stop using `Scaffold.of()`. `Scaffold.of().showSnackBar()` was deprecated in Flutter 2.0 and removed; the current API is on `ScaffoldMessenger`:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

Because the messenger lives above your screen's `Scaffold` (usually at the `MaterialApp` level), the upward lookup succeeds from your `build` context. As a bonus, `SnackBar`s now persist and animate across route transitions instead of vanishing when you navigate, which was the whole point of the `ScaffoldMessenger` redesign. `showSnackBar` also returns a `ScaffoldFeatureController` you can use to await the closed reason:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## Fix 2: get a context under the Scaffold with a Builder

Sometimes you genuinely need a context that is a descendant of the `Scaffold`: you are calling `Scaffold.of(context)` for something other than a `SnackBar` (opening the drawer with `Scaffold.of(context).openDrawer()`, reading `Scaffold.of(context).hasAppBar`), or you set up a local `ScaffoldMessenger` and need to resolve *that* one. The cheapest fix is a `Builder`, which introduces a fresh context whose position in the tree is below the `Scaffold`:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

The `Builder` does nothing but call its `builder` function, but the `innerContext` it passes belongs to an element that is a child of the `Scaffold`. Now the upward walk hits the `Scaffold` (and the messenger scope) immediately. Use the inner context, not the outer one -- that is the entire trick.

## Fix 3: extract the caller into its own widget

`Builder` is a shortcut for a structural fix: split the button out into a separate `StatelessWidget` or `StatefulWidget`. Its `build` method receives a context that is naturally below the `Scaffold`, so `.of()` resolves correctly and you never think about it again:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

This is the option to prefer for anything beyond a throwaway callback. It is more readable than a nested `Builder`, keeps your screen widget thin, and makes the button independently testable.

## Fix 4: use a GlobalKey when there is no usable context

The context-based fixes assume you are inside the widget tree at the moment you show the message. When you are not -- a `SnackBar` fired from a `bloc`, a repository, a background callback, or an error handler that has no `BuildContext` -- reach the messenger through a `GlobalKey<ScaffoldMessengerState>` wired into `MaterialApp`:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` is null until the app has mounted, so guard it with `?.`. This is the officially recommended pattern for showing a `SnackBar` from outside a widget, and it sidesteps the "which context?" question entirely because there is no context involved.

## Gotchas and lookalikes

**`maybeOf` returns null instead of throwing.** If you want to *attempt* to show a message and quietly do nothing when there is no messenger (rare, but useful in shared code that may run outside a Material tree), use `ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)`. It performs the same lookup but returns `null` rather than asserting. Do not reach for it to paper over a real structural bug -- if you expect a messenger to be there, the assertion is doing you a favor.

**Calling `.of()` in `initState`.** A common variant is trying to show a `SnackBar` in `initState`. The context exists, but the frame has not been laid out and you are still inside build/mount. Defer it: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`. Better still, use the `GlobalKey` from Fix 4 so you are not depending on `context` timing at all.

**Using the context after an `await`.** Grabbing `ScaffoldMessenger.of(context)` after an asynchronous gap can throw or resolve a stale messenger if the widget was disposed while you awaited. Capture the messenger *before* the await, or guard on `mounted`. This is the same discipline as [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) and [guarding setState with the mounted check](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).

**The `SnackBar` shows on the wrong screen.** No crash, but the message appears on a different route than you expected. That is a *which messenger* problem, not a *no messenger* problem: you resolved the root `MaterialApp` messenger when you wanted a nested `ScaffoldMessenger` you wrapped a subtree in. Resolve from a context inside that nested scope (Fix 2 or Fix 3), or hold a key to the specific messenger.

**`showModalBottomSheet` and `openDrawer` hit the same wall.** Any `Scaffold.of(context)` call from the screen's own `build` context fails identically, not just `showSnackBar`. `Scaffold.of(context).openDrawer()` and `showModalBottomSheet(context: context, ...)` both need a context below the `Scaffold`. The `Builder` and extract-a-widget fixes apply unchanged.

**It is an assertion, so release builds behave differently.** The `of()` failure asserts in debug and throws in release. Do not assume a release build that "didn't crash in testing" is safe -- if the messenger really is missing, release will throw too. Resolve it in debug.

If your actual failure is a different Material widget complaining it can't find an ancestor -- `No MaterialLocalizations found`, `No Directionality widget found`, `No MediaQuery widget ancestor found` -- the mechanism is the same upward-lookup miss, and the fix is the same shape: give the caller a context that sits below the widget it needs, or add the missing ancestor. Flutter's [looking up a deactivated widget's ancestor is unsafe](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) is the timing-based cousin of this structural error.

## Related

- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- capturing the messenger before an async gap so it is still valid when the `SnackBar` fires.
- [How to guard setState with the mounted check after an async gap in Flutter](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- the same lifecycle discipline that keeps post-await `.of()` calls safe.
- [Fix: Looking up a deactivated widget's ancestor is unsafe in Flutter](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- the timing-based ancestor-lookup failure, versus this structural one.
- [Fix: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- another "wrong place in the widget tree" error that the framework catches at build time.

## Sources

- [SnackBars managed by the ScaffoldMessenger, Flutter breaking changes](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- the migration from `Scaffold.of().showSnackBar` to `ScaffoldMessenger.of().showSnackBar`, the `scaffoldMessengerKey`, and the exact "No ScaffoldMessenger widget found" assertion.
- [ScaffoldMessenger.of, Flutter API reference](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- documents that `of()` asserts in debug and throws in release when no messenger is in scope, and points to `maybeOf` and the `GlobalKey` pattern.
- [ScaffoldMessenger.maybeOf, Flutter API reference](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- the null-returning lookup for when a messenger may legitimately be absent.
- [Scaffold.of, Flutter API reference](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- the classic "context that does not contain a Scaffold" message and the `Builder` remedy.
