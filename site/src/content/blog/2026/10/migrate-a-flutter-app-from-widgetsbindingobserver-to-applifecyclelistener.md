---
title: "Migrate a Flutter App from WidgetsBindingObserver.didChangeAppLifecycleState to AppLifecycleListener (Flutter 3.13+)"
description: "Replace hand-rolled WidgetsBindingObserver lifecycle code with AppLifecycleListener: the callback mapping, the state machine it enforces, the new hidden state that breaks exhaustive switches, desktop exit requests, and the test that suddenly asserts. Tested on Flutter 3.44.8 with Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
---

If your Flutter app still mixes `WidgetsBindingObserver` into a `State` just to override `didChangeAppLifecycleState`, the replacement is `AppLifecycleListener`, added in Flutter 3.13.0. You create one listener object in `initState`, pass it only the callbacks you care about (`onResume`, `onPause`, `onHide`, `onShow`, `onInactive`, `onRestart`, `onDetach`, `onStateChange`, `onExitRequested`), and call `dispose()` on it. No mixin, no `addObserver`/`removeObserver` pair, no `switch` over `AppLifecycleState`. The migration of one observer takes about 10 minutes, and it is behavior-preserving as long as you know two things: since 3.13 the framework inserts the intermediate states (`resumed` to `paused` now arrives as `inactive`, `hidden`, `paused`), and the new `AppLifecycleState.hidden` value turns every exhaustive `switch` without a `default` into a compile error. Everything below was run on Flutter 3.44.8 (Dart 3.12.2).

## Why move off the raw observer

- **Less code, fewer leaks.** The observer pattern needs three coordinated pieces: the mixin, `WidgetsBinding.instance.addObserver(this)` in `initState`, and `removeObserver(this)` in `dispose`. Forgetting the last one keeps a disposed `State` alive in the binding's observer list and makes it receive callbacks after unmount. `AppLifecycleListener` registers itself in its constructor and unregisters in `dispose()`, so there is one call to remember, the same one you already make for controllers.
- **Transitions, not states.** `didChangeAppLifecycleState` tells you where the app is. Most app logic cares about how it got there: "the app came back from the background" is `paused` to `hidden` (`onRestart`), which is different from "a system dialog closed" (`inactive` to `resumed`, `onResume`). The listener tracks the previous state and calls the callback that names the transition.
- **Desktop exit requests in the same object.** `onExitRequested` lets a Windows, macOS or Linux app cancel a close to show an "unsaved changes" prompt. With the raw observer that is a separate override, `didRequestAppExit`.
- **It can live outside the widget tree.** The listener is a plain Dart object that only needs a `WidgetsBinding`. A repository, an analytics service or a Riverpod provider can own one and dispose it with the service.

## What changes in the app

| Area | Change | Severity |
| --- | --- | --- |
| `switch (state)` statements | `AppLifecycleState.hidden` (added in 3.13) makes switches without `default` fail with `non_exhaustive_switch_statement` | high |
| Widget tests calling `handleAppLifecycleStateChanged` directly | Jumping from `resumed` to `paused` now fails an assertion inside the listener | high |
| Observer `State` classes | Mixin and `addObserver`/`removeObserver` removed, replaced by one field and `dispose()` | medium |
| Callback order | `onStateChange` fires after the transition callback, once per intermediate state | low |
| Exit handling | `didRequestAppExit` override moves to `onExitRequested`; `AppExitResponse` comes from `dart:ui` | low |

## Pre-flight checklist

- Flutter 3.13.0 or later (`flutter --version`). `AppLifecycleListener` does not exist in 3.10 and earlier, and the file `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` first appears at the 3.13.0 tag.
- Grep the codebase for `with WidgetsBindingObserver` and `didChangeAppLifecycleState`. Note which observers also override other callbacks such as `didChangeMetrics`, `didChangePlatformBrightness`, `didChangeLocales` or `didHaveMemoryPressure`. Those keep the mixin for the non-lifecycle callbacks; only the lifecycle part moves.
- Grep for `switch` statements and `if` chains over `AppLifecycleState`. Each one needs a decision about `hidden`.
- Grep tests for `handleAppLifecycleStateChanged`. Those are the tests that will start failing.
- Commit or stash first. This is a code-only migration with no data involved, so `git revert` is the rollback.

## Migration steps

1. **Map each `case` to a callback.** The listener's callbacks are named after transitions, not states. This is the mapping, taken from the source of `AppLifecycleListener.didChangeAppLifecycleState` in Flutter 3.44.8:

   | New state | Previous state | Callback |
   | --- | --- | --- |
   | `resumed` | `inactive` (or none) | `onResume` |
   | `inactive` | `resumed` (or none) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (or none) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (or none) | `onPause` |
   | `detached` | `paused` (or none) | `onDetach` |
   | any | any | `onStateChange(state)`, after the specific callback |

   A `case AppLifecycleState.paused:` becomes `onPause`, and `case AppLifecycleState.resumed:` becomes `onResume`. If the old code did something on `inactive` regardless of direction, use `onStateChange` and keep the `if`, because `inactive` is reached from two directions and maps to two different callbacks. Verify: every branch of the old `switch` has exactly one destination in your notes.

2. **Replace the mixin with a listener field.** This is the typical before:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - BEFORE
   class PlayerScreen extends StatefulWidget {
     const PlayerScreen({super.key});
     @override
     State<PlayerScreen> createState() => _PlayerScreenState();
   }

   class _PlayerScreenState extends State<PlayerScreen>
       with WidgetsBindingObserver {
     @override
     void initState() {
       super.initState();
       WidgetsBinding.instance.addObserver(this);
     }

     @override
     void didChangeAppLifecycleState(AppLifecycleState state) {
       switch (state) {
         case AppLifecycleState.resumed:
           _player.resume();
         case AppLifecycleState.paused:
           _player.pause();
           _saveProgress();
         default:
           break;
       }
     }

     @override
     void dispose() {
       WidgetsBinding.instance.removeObserver(this);
       super.dispose();
     }

     // _player, _saveProgress and build() omitted
   }
   ```

   And the after:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - AFTER
   class _PlayerScreenState extends State<PlayerScreen> {
     late final AppLifecycleListener _lifecycle;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onResume: () => _player.resume(),
         onPause: () {
           _player.pause();
           _saveProgress();
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     // _player, _saveProgress and build() unchanged
   }
   ```

   The constructor calls `binding.addObserver(this)` itself, so creating the object is the subscription. Verify: `flutter analyze` reports no unused `WidgetsBindingObserver` import issues and the class no longer has a `with` clause (unless it still needs other observer callbacks, see step 4).

3. **Decide what `hidden` means for your logic.** `AppLifecycleState.hidden` was added in Flutter 3.13 for desktop and web, where an app can be minimized or in a background tab without being "paused" in the mobile sense. On iOS and Android the framework synthesizes it between `inactive` and `paused`. If you used `onPause` to stop a video, that still works everywhere it worked before. If you want the video to stop when a desktop window is minimized too, `onHide` is the callback that fires on every platform, with `onShow` as its counterpart. For anything that should only happen when the user leaves the app on mobile (saving a draft, flushing analytics), `onPause` plus `onRestart` is the pair. Verify: write down, per callback, which platforms you ship to and whether it fires there (`onRestart` and `onDetach` are documented as mobile-only).

4. **Keep the mixin only for non-lifecycle callbacks.** `AppLifecycleListener` covers `didChangeAppLifecycleState` and `didRequestAppExit` and nothing else. If an observer also overrides `didChangeMetrics` to react to keyboard insets, leave the mixin in place for that override and move only the lifecycle method out. Verify: grep the class for `@override` methods from `WidgetsBindingObserver` after the edit; if none remain, remove the mixin and the `addObserver`/`removeObserver` calls.

5. **Move `didRequestAppExit` to `onExitRequested`** (desktop only). The callback returns a `Future<AppExitResponse>`, and that enum lives in `dart:ui`, not in `package:flutter/widgets.dart` or `services.dart`. Without the import you get `Undefined name 'AppExitResponse'`.

   ```dart
   // Flutter 3.44.8, Dart 3.12.2
   import 'dart:ui' show AppExitResponse;
   import 'package:flutter/material.dart';

   class _EditorState extends State<Editor> {
     late final AppLifecycleListener _lifecycle;
     bool _dirty = false;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onExitRequested: () async {
           if (!_dirty) return AppExitResponse.exit;
           final discard = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard unsaved changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.pop(context, false),
                   child: const Text('Cancel'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.pop(context, true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           );
           return discard == true ? AppExitResponse.exit : AppExitResponse.cancel;
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) => const Placeholder();
   }
   ```

   Only cancelable exits reach this callback. `ServicesBinding.instance.exitApplication(AppExitType.required)` exits without asking. Note that `WidgetsBinding.handleRequestAppExit` asks every observer, even after one has answered `cancel`, and cancels the exit if any of them did. One listener anywhere in the app can veto the exit, and every other listener's `onExitRequested` still runs, so do not put irreversible cleanup there. Verify: run on desktop, make the editor dirty, close the window, and confirm the dialog appears and "Cancel" keeps the window open.

6. **Fix the `switch` statements that the `hidden` value broke.** If you keep a `switch` (for example inside `onStateChange`), it must cover `hidden`. This compiles on Flutter 3.10 and fails on 3.13+:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - fails flutter analyze
   String describe(AppLifecycleState state) {
     switch (state) {
       case AppLifecycleState.resumed:
         return 'resumed';
       case AppLifecycleState.inactive:
         return 'inactive';
       case AppLifecycleState.paused:
         return 'paused';
       case AppLifecycleState.detached:
         return 'detached';
     }
   }
   ```

   The analyzer reports: "The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`). Add an explicit `case AppLifecycleState.hidden:` rather than a `default`, so the next enum value added by Flutter is a compile error again instead of a silent fall-through. Verify: `flutter analyze` is clean.

7. **Update the tests that drive lifecycle changes.** See the next section; this is where most migrations actually stall. Verify: `flutter test` passes.

## Verification

The fastest proof that behavior is unchanged is a widget test that sends lifecycle changes the same way the engine does: a string on the `flutter/lifecycle` channel. That path goes through the binding's transition generator, exactly like a real device.

```dart
// Flutter 3.44.8, Dart 3.12.2 - test/lifecycle_test.dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> sendLifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  testWidgets('background and foreground', (tester) async {
    final log = <String>[];
    final listener = AppLifecycleListener(
      onResume: () => log.add('onResume'),
      onInactive: () => log.add('onInactive'),
      onHide: () => log.add('onHide'),
      onShow: () => log.add('onShow'),
      onPause: () => log.add('onPause'),
      onRestart: () => log.add('onRestart'),
      onStateChange: (s) => log.add('state:${s.name}'),
    );
    addTearDown(listener.dispose);

    await sendLifecycle(tester, AppLifecycleState.resumed);
    await sendLifecycle(tester, AppLifecycleState.paused);
    await sendLifecycle(tester, AppLifecycleState.resumed);

    expect(log, [
      'onResume', 'state:resumed',
      'onInactive', 'state:inactive',
      'onHide', 'state:hidden',
      'onPause', 'state:paused',
      'onRestart', 'state:hidden',
      'onShow', 'state:inactive',
      'onResume', 'state:resumed',
    ]);
  });
}
```

This passes on 3.44.8 and documents three facts in one place. A platform jump from `resumed` straight to `paused` arrives as three steps. The way back runs `onRestart`, `onShow`, `onResume`, in that order. And `onStateChange` always comes after the named callback for the same step. Sending `resumed` twice in a row produces nothing the second time, because both the binding and the listener drop repeated states.

Then the manual checks: on Android and iOS, background the app and bring it back, and confirm the work you moved to `onPause` and `onResume` still happens once each. On desktop, minimize and restore if you moved anything to `onHide`/`onShow`, and close the window if you implemented `onExitRequested`.

## Rolling back

The migration is a pure code change; no persisted state is involved. `git revert` the commit and you are back on the observer. The only thing that will not revert cleanly is a `switch` you fixed for `hidden`: keep that fix, because the old code was already broken on 3.13+.

## Gotchas from a real migration

### Tests that call `handleAppLifecycleStateChanged` now assert

Many test suites simulate backgrounding with `tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)`. That method dispatches the given state directly, without the synthesized intermediate states. A plain observer does not care. The listener validates every transition, so with the app in `resumed` this test fails:

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

The failure is an assertion thrown while dispatching to observers: "Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused", and `onPause` is never called. Either send each intermediate state yourself (`inactive`, `hidden`, `paused`) or use the `flutter/lifecycle` channel helper from the Verification section, which lets the framework generate them. The assertion only exists in debug builds, so release behavior is not affected; the risk is purely a red test suite.

### The listener only sees changes after it is created

The constructor snapshots `binding.lifecycleState` and treats it as the previous state. If you create the listener on a screen pushed long after startup, no `onResume` fires for the current state, because there was no transition. The old observer had the same behavior, but code sometimes relied on an `initState` call to "do the resume logic once". Keep that explicit: read `WidgetsBinding.instance.lifecycleState` in `initState` if you need the current state, the same as before.

### Old observers also see the synthesized states

The intermediate-state generation lives in `ServicesBinding`, not in the listener. In the repro above, a plain `WidgetsBindingObserver` registered alongside the listener received `inactive`, `hidden`, `paused` for a single platform `paused` message, too. So if an observer you have not migrated yet does "on anything other than `resumed`, pause playback", it now runs that code three times per backgrounding. Make such handlers idempotent or migrate them to a single named callback.

### Creating a listener before `runApp`

`AppLifecycleListener()` defaults its `binding` to `WidgetsBinding.instance`, which throws if the binding is not initialized yet. A listener owned by a service that is built in `main()` before `runApp` needs `WidgetsFlutterBinding.ensureInitialized()` first. For services that outlive any widget, also make sure something calls `dispose()`; with Riverpod that is `ref.onDispose(listener.dispose)` in the provider that creates it.

### `onExitRequested` is not a mobile back-button hook

It is tempting to treat `onExitRequested` as "the app is about to close" on Android. It is not: in the engine source, only the Windows, macOS and Linux embedders send exit requests, so it never fires on Android or iOS. To intercept the Android back gesture, use `PopScope`. To run cleanup when a mobile app goes away, use `onPause`; `onDetach` is not guaranteed to run before the OS kills a backgrounded process.

## Related

- The listener's `dispose()` belongs next to the rest of your teardown; see [how to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Pausing a stream when the app goes to the background is a common `onPause` job, and [cancelling a StreamSubscription in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) covers the other half.
- `onPause` is not your last chance on Android: the OS can kill the process afterwards. [Restoring UI state after Android process death with RestorationMixin](/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) handles what comes back.
- If you are cleaning up several deprecated APIs at once, [running dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) automates the mechanical ones (this migration is not one of them).
- `onExitRequested` matters most in desktop apps with several windows; see [enabling multi-window support in a Flutter desktop app](/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

## Sources

- [`AppLifecycleListener` class](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [`AppLifecycleState` enum and state diagram](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [`WidgetsBindingObserver` class](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [`app_lifecycle_listener.dart` source](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) and [`ServicesBinding` transition generation](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: new `AppLifecycleState.hidden` enum value](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
