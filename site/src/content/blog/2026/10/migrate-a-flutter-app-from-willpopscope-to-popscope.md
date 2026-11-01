---
title: "Migrate a Flutter app from WillPopScope to PopScope and onPopInvokedWithResult (Flutter 3.16 to 3.47)"
description: "WillPopScope and onPopInvoked are deprecated, and predictive back on Android 14+ ignores them. How to move each onWillPop pattern to PopScope.canPop and onPopInvokedWithResult, the confirm-dialog loop you have to guard against, the PopScope<T> type crash, and what dart fix will not do for you. Tested on Flutter 3.44.8."
pubDate: 2026-10-14
updatedDate: 2026-10-14
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "android"
---

This migration takes 10 to 30 minutes per screen, and it is not a rename. `WillPopScope` asked your code "may I pop?" at the moment the back gesture arrived and waited for a `Future<bool>`. `PopScope` wants the answer ahead of time in a synchronous `canPop` boolean, and tells you afterwards, through `onPopInvokedWithResult(bool didPop, T? result)`, that a pop happened or was blocked. `WillPopScope` and `Form.onWillPop` have been deprecated since Flutter 3.16 (deprecated after `v3.12.0-1.0.pre`), `PopScope.onPopInvoked` since Flutter 3.24, and `dart fix` rewrites none of them. It is worth doing now: with `WillPopScope` in the tree, the Android predictive back animation does not work. Everything below was compiled and run as widget tests on Flutter 3.44.8 (Dart 3.12), and the `PopScope` source was checked against the current `master` branch, which matches what ships in Flutter 3.47.

## Why WillPopScope had to go

Android 14 introduced [predictive back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture): as soon as the user starts the swipe, the system animates the current screen away and shows a preview of what is behind it. The animation starts before the gesture is committed, so there is no point at which the platform can stop and ask a Flutter callback whether the pop is allowed. An async `onWillPop` that shows a dialog fundamentally cannot fit into that model.

Flutter's answer, from [issue #109513](https://github.com/flutter/flutter/issues/109513) and [PR #120385](https://github.com/flutter/flutter/pull/120385), was to replace every "just-in-time" back API with an "ahead-of-time" one:

- **`WillPopScope(onWillPop:)`** becomes **`PopScope(canPop:, onPopInvokedWithResult:)`**.
- **`Form.onWillPop`** becomes **`Form.canPop`** plus **`Form.onPopInvokedWithResult`**.
- **`Route.willPop()`** (a `Future<RoutePopDisposition>`) becomes the synchronous getter **`Route.popDisposition`**.
- **`ModalRoute.addScopedWillPopCallback`** / **`removeScopedWillPopCallback`** become **`registerPopEntry`** / **`unregisterPopEntry`**.

A second round in Flutter 3.24 ([PR #147607](https://github.com/flutter/flutter/pull/147607)) made `PopScope` generic so the callback can see the value passed to `Navigator.pop(context, result)`, and deprecated the first-generation `onPopInvoked(bool didPop)` in favor of `onPopInvokedWithResult(bool didPop, T? result)`. If you migrated in 2023 and stopped, you are holding the second deprecated API.

On Android 16 the pressure goes up: for apps targeting API level 36, the [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16) turn the predictive back system animations on by default and stop dispatching `onBackPressed()` and `KEYCODE_BACK`.

## What breaks

| Area | Change | Deprecated in stable | Severity |
| ---- | ------ | -------------------- | -------- |
| `WillPopScope` | Replaced by `PopScope`; blocks predictive back | 3.16 | high |
| `Form.onWillPop` | Replaced by `Form.canPop` + `Form.onPopInvokedWithResult` | 3.16 | high |
| `PopScope.onPopInvoked` | Replaced by `onPopInvokedWithResult` | 3.24 | medium |
| `Form.onPopInvoked` | Replaced by `Form.onPopInvokedWithResult` | 3.24 | medium |
| `NavigatorPopHandler.onPop` | Replaced by `onPopWithResult` | 3.27 | low |
| `Route.willPop()` | Replaced by synchronous `Route.popDisposition` | 3.16 | low (custom routes only) |
| `ModalRoute.addScopedWillPopCallback` | Replaced by `registerPopEntry` | 3.16 | low (custom pop widgets only) |

None of these are removed yet. On Flutter 3.44.8, `flutter analyze` reports them as `deprecated_member_use` infos:

```text
info • 'WillPopScope' is deprecated and shouldn't be used. Use PopScope instead. The Android predictive back feature will not work with WillPopScope. This feature was deprecated after v3.12.0-1.0.pre. • lib/legacy.dart:8:7 • deprecated_member_use
info • 'onPopInvoked' is deprecated and shouldn't be used. Use onPopInvokedWithResult instead. This feature was deprecated after v3.22.0-12.0.pre. • lib/legacy.dart:9:16 • deprecated_member_use
info • 'onWillPop' is deprecated and shouldn't be used. Use canPop and/or onPopInvokedWithResult instead. This feature was deprecated after v3.12.0-1.0.pre. • lib/legacy.dart:10:12 • deprecated_member_use
```

On the same file, `dart fix --dry-run` prints `Nothing to fix!`. The semantics differ too much for a mechanical rewrite, so every call site needs a human decision.

## Pre-flight checklist

- Flutter 3.24 or later, so you can go straight to `onPopInvokedWithResult` and skip the intermediate `onPopInvoked` API. Check with `flutter --version`.
- A list of every call site: `grep -rn -E "WillPopScope|onWillPop|onPopInvoked\b|willPop\(|ScopedWillPopCallback" lib/`.
- If you treat infos as errors in CI (`flutter analyze --fatal-infos`), expect the deprecation lines above to be what is currently being suppressed with `// ignore: deprecated_member_use`. Grep for those comments too.
- An Android 14+ device or emulator with gesture navigation enabled, because the bugs this migration introduces show up on real back gestures, not on the app bar back button.

## Migration steps

1. **Classify each `onWillPop` by what it actually does.** Almost every `WillPopScope` in the wild is one of four shapes: always block (`return false`), block based on state (`return !_dirty`), run a side effect and allow (`_save(); return true`), or ask the user (`await showDialog(...)`). A fifth, intercepting back for a nested `Navigator`, gets its own widget in step 6. Write the shape next to each grep hit; it decides which pattern below you use. Verify: no call site is left unclassified.

2. **Move synchronous decisions into `canPop`.** If `onWillPop` returned a value it could have computed without awaiting, that value is now `canPop`, evaluated on every build:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   // Before
   WillPopScope(
     onWillPop: () async => !_hasUnsavedChanges,
     child: editor,
   )

   // After
   PopScope(
     canPop: !_hasUnsavedChanges,
     child: editor,
   )
   ```

   The key consequence: whatever drives `canPop` must trigger a rebuild when it changes. If `_hasUnsavedChanges` is a plain field mutated without `setState` (or without your state management notifying), `canPop` goes stale and the route stays blocked, or stays poppable, after the user saves. Verify: in a widget test, flip the state, `pump()`, call `tester.binding.handlePopRoute()`, and assert the route is gone. My test of this pattern logged `didPop=false` before the save and `didPop=true` after.

3. **Move side effects into `onPopInvokedWithResult`.** If `onWillPop` did work and then returned `true`, keep `canPop: true` and run the work in the callback. It now runs after the pop has been handled, not before:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   PopScope<void>(
     canPop: true,
     onPopInvokedWithResult: (bool didPop, void result) {
       if (didPop) {
         _analytics.logScreenExit('editor');
       }
     },
     child: editor,
   )
   ```

   Anything that has to read the widget's `BuildContext` after this point is reading the context of a route that is on its way out. Grab what you need (a `NavigatorState`, a `ScaffoldMessengerState`) before you do anything async. Verify: the side effect fires exactly once per back press.

4. **Rewrite confirmation dialogs as "block, then pop manually".** This is the pattern most apps need, and the one most often written wrong:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   PopScope<Object?>(
     canPop: false,
     onPopInvokedWithResult: (bool didPop, Object? result) async {
       if (didPop) {
         return; // our own navigator.pop() below lands here
       }
       final NavigatorState navigator = Navigator.of(context);
       final bool shouldLeave = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.of(context).pop(false),
                   child: const Text('Stay'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.of(context).pop(true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           ) ??
           false;
       if (shouldLeave) {
         navigator.pop(result);
       }
     },
     child: editor,
   )
   ```

   The `if (didPop) return;` guard is not decoration. When you call `navigator.pop(result)` yourself, the same callback fires a second time, now with `didPop == true`. My widget test logged exactly that sequence: `didPop=false result=null`, then `didPop=true result=null`. Without the guard, the second invocation opens the dialog again on a route that has already popped. Also note `navigator` is captured before the `await`, the same rule covered in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/). Verify: system back shows the dialog once, "Discard" leaves, "Stay" keeps the screen.

5. **Migrate `Form.onWillPop`.** `Form` builds its own `PopScope` internally, so it takes the same two parameters directly:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   Form(
     key: _formKey,
     canPop: !_isDirty,
     onPopInvokedWithResult: (bool didPop, Object? result) {
       if (!didPop) {
         ScaffoldMessenger.of(context).showSnackBar(
           const SnackBar(content: Text('Save or discard your changes first.')),
         );
       }
     },
     child: fields,
   )
   ```

   Do not wrap the `Form` in another `PopScope` with the same logic; both entries register with the route, and any one of them with `canPop: false` blocks the pop. Verify: `flutter analyze` no longer reports `onWillPop` on this file.

6. **Use `NavigatorPopHandler` for nested navigators.** The classic tab-with-its-own-stack code becomes:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   // Before
   WillPopScope(
     onWillPop: () async => !(await _tabNavigatorKey.currentState!.maybePop()),
     child: Navigator(key: _tabNavigatorKey, onGenerateRoute: _onGenerateRoute),
   )

   // After
   NavigatorPopHandler(
     onPopWithResult: (Object? result) => _tabNavigatorKey.currentState!.maybePop(result),
     child: Navigator(key: _tabNavigatorKey, onGenerateRoute: _onGenerateRoute),
   )
   ```

   `NavigatorPopHandler` disables the outer pop while the inner navigator has more than one route, and hands you the back event so you can pop the inner stack. If you use go_router's `StatefulShellRoute`, it already wires this up for each branch, as described in [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/). Verify: back inside a tab pops within the tab; back at the tab root leaves the shell.

7. **Replace `onPopInvoked` from a first-round migration.** Change the parameter name, add the `result` parameter, and add a type argument that matches the route:

   ```dart
   // Flutter 3.44.8, Dart 3.12
   // Before (deprecated since 3.24)
   PopScope(
     canPop: false,
     onPopInvoked: (bool didPop) { /* ... */ },
     child: child,
   )

   // After
   PopScope<int>(
     canPop: false,
     onPopInvokedWithResult: (bool didPop, int? result) { /* ... */ },
     child: child,
   )
   ```

   Passing both callbacks trips an assert (`onPopInvoked is deprecated, use onPopInvokedWithResult`). Verify: grep for `onPopInvoked:` returns nothing.

8. **Turn on predictive back on Android.** Add the flag to the `<application>` element in `android/app/src/main/AndroidManifest.xml`. `flutter create` on 3.44.8 still does not generate it:

   ```xml
   <!-- Flutter 3.44.8, Android 13+ -->
   <application
       android:label="my_app"
       android:name="${applicationName}"
       android:icon="@mipmap/ic_launcher"
       android:enableOnBackInvokedCallback="true">
   ```

   For the in-app route animation to follow the finger as well, opt `TargetPlatform.android` into `PredictiveBackPageTransitionsBuilder` in your `PageTransitionsTheme`; the builders reorganization that affects this theme is covered in [migrating custom page transitions after the Flutter page transition builders reorganization](/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/). Verify: on an Android 14+ device, a slow back swipe on a poppable route shows the preview; on a `canPop: false` route it does not.

## Verification

- `flutter analyze` reports zero `deprecated_member_use` hits for `WillPopScope`, `onWillPop` and `onPopInvoked`, with no new `// ignore:` comments.
- Widget tests use `tester.binding.handlePopRoute()` to simulate the system back button, not `Navigator.pop()`, because `Navigator.pop()` bypasses `canPop` (see the gotchas).
- Manual pass on Android with gesture navigation: every blocked screen stays put, every confirmation dialog appears once.
- Manual pass on iOS: edge swipe is disabled on blocked screens, and the in-app back button still works through your own logic.

## Rollback plan

The migration is reversible because the old APIs still exist in Flutter 3.47. Reverting the commit restores `WillPopScope` behavior and the deprecation infos. You lose predictive back on any route that contains a `WillPopScope`, so if you must roll back one screen, roll back only that screen and leave the rest on `PopScope`.

## Gotchas

**`Navigator.pop()` ignores `canPop`.** `canPop: false` blocks the system back gesture and `Navigator.maybePop()`, but a direct `Navigator.of(context).pop()` pops anyway. My test called `pop(42)` on a `canPop: false` route; the route left, and the callback logged `didPop=true result=42`. That is what makes the confirm-dialog pattern possible, and also how a "Cancel" button in your own app bar silently skips the guard. Route those buttons through `maybePop()`.

**`maybePop()` returns `true` even when blocked.** With `canPop: false`, `maybePop(7)` returned `true`, the route stayed, and the callback got `didPop=false result=7`. `true` means "the navigator handled it", not "the route is gone". Do not use the return value to decide whether you left the screen.

**The type argument must match the route, or it crashes at runtime.** A `PopScope<String>` inside a `MaterialPageRoute<int>` compiles cleanly. Pop with a value and you get:

```text
type 'int' is not a subtype of type 'String?' of 'result'
#0      _PopScopeState.onPopInvokedWithResult (package:flutter/src/widgets/pop_scope.dart:180:47)
#1      ModalRoute.onPopInvokedWithResult (package:flutter/src/widgets/routes.dart:2047:16)
```

Use the route's own type, or `PopScope<Object?>` for widgets reused across routes with different result types. A `MaterialPageRoute` written without a type argument is a `MaterialPageRoute<dynamic>`, so `Object?` is the safe default when you are not sure.

**The official migration guide's `NavigatorPopHandler` sample is itself deprecated.** The breaking-change page still shows `NavigatorPopHandler(onPop: ...)`, but `onPop` was deprecated after `v3.26.0-0.1.pre` in favor of `onPopWithResult`, which is why step 6 uses the latter. Copying the doc sample verbatim trades one deprecation info for another.

**iOS swipe-back disappears entirely.** With `canPop: false` under a Cupertino-style transition, the edge swipe is not recognized at all, so `onPopInvokedWithResult` never fires for it. That is by design, but it means "show a dialog on swipe" is impossible on iOS. Users get the dialog only from the back button or a programmatic `maybePop()`.

**One blocked entry blocks the route.** Every `PopScope` and `Form` in a route's subtree registers a `PopEntry`. If any of them says `canPop: false`, the route's `popDisposition` is `doNotPop`. A forgotten `PopScope(canPop: false)` deep in a reusable widget explains most "back stopped working on this screen" bugs after a migration.

**Root routes still exit the app.** `canPop: true` on the first route does what Android always did: the activity finishes. If you used `WillPopScope` on a home screen for "press back again to exit", rebuild it with `canPop: false` and a timestamp check in the callback, calling `SystemNavigator.pop()` on the second press. The .NET MAUI version of the same problem, for comparison, is in [intercepting the Android back button on a MAUI Shell root page](/2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page/).

## Related

- For other deprecations that need hand edits after `dart fix` runs clean, see [running dart fix across a whole repo to apply Flutter migrations](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/).
- The same "state lives on the parent, the widget just reflects it" shift appeared in [replacing Radio groupValue and onChanged with RadioGroup](/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Async dialogs inside `onPopInvokedWithResult` depend on [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Predictive back animations between pages: [migrating custom page transitions after the builders reorganization](/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/).
- Nested stacks with go_router: [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

## Sources

- [Android predictive back](https://docs.flutter.dev/release/breaking-changes/android-predictive-back), Flutter breaking changes (landed 3.14.0-7.0.pre, stable 3.16).
- [Generic types in PopScope](https://docs.flutter.dev/release/breaking-changes/popscope-with-result), Flutter breaking changes (landed 3.22.0-26.0.pre, stable 3.24).
- [Add the predictive back gesture](https://docs.flutter.dev/platform-integration/android/predictive-back), Flutter docs.
- [`PopScope`](https://api.flutter.dev/flutter/widgets/PopScope-class.html) and [`NavigatorPopHandler`](https://api.flutter.dev/flutter/widgets/NavigatorPopHandler-class.html) API references.
- [`pop_scope.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/pop_scope.dart) on flutter/flutter `master`.
- [Android 16 behavior changes: predictive back](https://developer.android.com/about/versions/16/behavior-changes-16).
