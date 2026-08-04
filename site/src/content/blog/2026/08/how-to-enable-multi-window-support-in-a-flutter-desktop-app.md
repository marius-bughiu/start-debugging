---
title: "How to enable multi-window support in a Flutter desktop app"
description: "Flutter 3.44.8 stable still ships no public multi-window API. Here is how to turn on the experimental windowing feature flag on the main channel, use RegularWindowController and WindowManager to open real top-level windows, and what to ship instead if you need stable today."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
---

Flutter's multi-window support exists, it works, and you cannot use it from a stable build. As of Flutter 3.44.8 (released 2026-07-23), the framework ships a complete windowing API in `packages/flutter/lib/src/widgets/_window.dart`, but every class in it is marked `@internal`, the file is not exported from `package:flutter/widgets.dart`, and every constructor throws `UnsupportedError` unless the `windowing` feature flag is on. That flag is only available on the `main` channel. So there are exactly two honest answers: switch to `main`, run `flutter config --enable-windowing`, and use the real framework API for prototyping, or stay on stable and use the `desktop_multi_window` plugin, which gets you separate windows at the cost of separate engines and separate isolates. This post covers both, with the exact API surface as it stands in 3.44.

## Why `runApp` can only ever give you one window

The reason single-window has been the default for so long is not laziness, it is that `runApp` attaches your widget tree to the *implicit view*: the one `FlutterView` that the platform embedder created for you before Dart even started. There is no seam in that call for a second view, and there never was.

The escape hatch has been `runWidget` for a while, which takes a widget tree rooted at `View` or `ViewCollection` rather than assuming the implicit view. What was missing was the other half: a way to ask the platform to *create* a native window and hand you back a `FlutterView` bound to it. That is what the windowing API adds. Canonical has been leading the implementation, and Flutter 3.44 landed tooltip windows on all three desktop platforms, popup windows on macOS, satellite window controllers, and a windowing-backed `showDialog`.

The design decision that matters most for your architecture: **all windows share one engine and one isolate**. Two windows are two subtrees of the same widget tree. A `ValueNotifier` held in a common ancestor is visible to both, with no serialization, no method channel, no `SendPort`. That is the single biggest difference from every plugin-based approach, and it is why waiting for this API is often the right call.

## Turning on the windowing feature flag

The flag is defined in `flutter_tools` as:

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

Note what is absent: there is no `beta:` and no `stable:` entry, so both default to `FeatureChannelSetting()` with `available: false`. Beta will not work either. It is `main` or nothing.

Enable it in three steps:

1. **Switch to the main channel.** Run `flutter channel main` followed by `flutter upgrade`. If you need your existing stable toolchain intact, pin a second SDK with FVM instead of moving your only checkout; the same technique described in [running one project against several Flutter SDKs in CI](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) works fine locally.
2. **Turn the flag on.** Run `flutter config --enable-windowing`. This writes a persistent setting, so you only do it once per SDK. For CI, set the environment variable `FLUTTER_WINDOWING=true` instead, which the tool reads as an override.
3. **Rebuild, do not hot-restart.** The tool forwards enabled flags to the framework as a compile-time define named `FLUTTER_ENABLED_FEATURE_FLAGS`. The framework reads it in `packages/flutter/lib/src/foundation/_features.dart`:

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` is const-evaluated at build time, so a hot restart after flipping the config setting will not pick it up. Kill the app and run `flutter run -d windows` (or `macos`, or `linux`) again.

If you skip step 2 you get a very specific error that is worth recognising, because it is thrown from the constructor rather than at render time:

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## Importing an API that is not exported

Because `_window.dart` is a private library inside `package:flutter`, you cannot reach it through `package:flutter/widgets.dart`. You import the implementation file directly and silence two analyzer lints. This is exactly what Flutter's own `examples/multiple_windows` app does:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

Yes, this is ugly, and yes, it is the officially sanctioned way to try the feature right now. The `implementation_imports` lint exists to stop you doing this in a published package, which is precisely the guidance in the file header: do not import it in production apps or anything you push to pub.dev, because breaking changes will land in patch versions.

## A minimal two-window app

The smallest complete program: create a `RegularWindowController`, wrap it in a `RegularWindow`, and pass the whole thing to `runWidget` instead of `runApp`.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

Three things are load-bearing here.

`WidgetsFlutterBinding.ensureInitialized()` must come first. The `RegularWindowController` factory resolves `WidgetsBinding.instance.windowingOwner` immediately, and the platform `WindowingOwner` asserts that the engine is already initialised. Constructing a controller before the binding exists is the cause of the `WindowingOwner[Platform] must be created after the engine has been initialized` assertion tracked in flutter/flutter#178706.

The controller creates the native window in its constructor, not when the widget mounts. `RegularWindow` only renders into a window that already exists, which is why the docs are explicit that you own the lifetime and must call `destroy()` yourself.

`WindowManager` is optional for a single window but you want it from the start. It installs a `WindowRegistry` into the tree, which is how descendants open further windows without threading a controller down manually.

## Opening a second window at runtime

The pattern is: build a controller, wrap it in a `WindowEntry` with a builder for its content, and register it. `WindowManager` listens to the registry and renders each entry with the correct widget for its controller type.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

The `late final WindowEntry entry` dance is not an accident: the delegate needs to unregister the entry, and the entry needs the controller that the delegate is attached to. Flutter's own reference app uses the same forward reference.

Unregistering matters. `WindowRegistry.unregister` only removes the entry from the list so `WindowManager` stops rendering it; it does not destroy the window. Conversely `destroy()` tears down the native window but leaves a stale entry in the registry. The delegate is the join point: let the default `onWindowCloseRequested` destroy the window, then clean up the registry in `onWindowDestroyed`.

## Intercepting close, and the rest of the controller surface

`RegularWindowControllerDelegate` has exactly two hooks, and the default implementation of the first one is what actually closes your windows:

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

Override `onWindowCloseRequested` and *do not* call `super` when you want an "unsaved changes" prompt, then call `controller.destroy()` yourself once the user confirms. Forgetting that `super` is what closes the window is the most likely way to ship a window nobody can shut.

The controller itself exposes the state you would expect, all of it change-notifying because `BaseWindowController` extends `ChangeNotifier`: `contentSize`, `title`, `isActivated`, `isMaximized`, `isMinimized`, `isFullscreen`, and `rootView`. The mutators are `setSize`, `setConstraints`, `setTitle`, `setMaximized`, `setMinimized`, `setFullscreen(bool fullscreen, {Display? display})`, `activate`, and `destroy`. Every one of them is documented as a *request*: the platform is free to ignore it, so drive your UI from the notified state, never from what you asked for.

Inside a window's subtree, reach the controller through the `WindowScope` inherited model:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` is an `InheritedModel` keyed on aspects (content size, title, activated, maximized, minimized, fullscreen), so `contentSizeOf` will not rebuild your widget when the window is merely focused. Use `maybeOf` if the subtree can also run in the implicit window: windows created by the native entrypoint that `runApp` attaches to have no `WindowScope`, and `of` throws there.

## The other four window types

Regular windows are one of five controller types, all sealed under `BaseWindowController` and all rendered by `WindowManager` via a switch:

- `DialogWindowController({BaseWindowController? parent, ...})`. With a non-null `parent` the dialog is modal to it, has no system menu, is hidden from the window switcher, and closes when the parent closes. With `parent: null` it is modeless, can be minimized but not maximized, and gets a **disabled close button**. That last detail surprises people; if you want a closeable standalone window, you want a regular window, not a parentless dialog.
- `PopupWindowController`, positioned relative to an anchor rectangle. Implemented for macOS in 3.44; Windows and Linux are still landing.
- `TooltipWindowController`, implemented on all three desktop platforms in 3.44.
- `SatelliteWindowController`, the newest of the set, for palettes and toolbars that follow a parent window.

Flutter 3.44 also added a windowing-backed `showDialog` that opens a real native window instead of an overlay, gated behind a `useWindowing` flag on `MaterialApp`.

## What to do if you need this on stable

If you are shipping now, the framework API is off the table: implementation imports plus `@internal` plus documented breaking changes in patch versions is not a foundation for a production app. The practical answer remains `desktop_multi_window` 0.3.0 (published 2025-10-28), which supports Windows, Linux, and macOS.

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

New windows come from `WindowController.create(WindowConfiguration(...))`, and cross-window communication goes through `WindowMethodChannel`, which is a method channel and therefore asynchronous and codec-bound:

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

The architectural cost is the thing to plan around. Each window is its own Flutter engine, which means its own isolate, its own heap, and its own copy of every singleton you initialised in `main`. Shared state has to be serialized across a channel, exactly like talking to [platform-specific code over a MethodChannel](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). If you have ever structured an app around [a long-lived Dart isolate with SendPort and ReceivePort](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), the constraints will feel familiar: no shared mutable objects, everything through messages.

Design for it now and the eventual migration is cheap. Keep a single owner of application state, expose it through an interface, and let the transport (direct reference today under the framework API, method channel today under the plugin) sit behind that interface. This is the same "architecture first, polish later" point that [Flutter desktop apps keep proving](/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/).

## Gotchas that cost real time

**Controllers are `ChangeNotifier`s and you own their disposal.** A `RegularWindowController` held in `State` needs `controller.dispose()` in `dispose()`, on top of `destroy()` for the native window. The same discipline you already apply to [`AnimationController` and friends](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) applies here, with an extra native resource attached.

**Widget tests do not have windowing.** There is no `WindowingOwner` in the test binding, so any test that reaches a windowing constructor throws `UnsupportedError`. Flutter's own API example wraps `main` in a `try`/`on UnsupportedError` block specifically so smoke tests pass. Keep window creation out of widget-level code and behind a seam you can stub.

**`preferredSize` and `preferredConstraints` must agree.** The factory asserts `preferredConstraints.isSatisfiedBy(preferredSize)` when both are non-null. In release builds the assert is gone and the platform silently picks something else.

**`decorated: false` means you draw the chrome.** Undecorated windows landed in 3.44 (`Allow windows to be created undecorated`). You get no title bar, no border, and no drag region until you build them.

The tracking issue for the whole effort is flutter/flutter#30701, and the remaining work before the API goes public is small enough to be encouraging: flutter/flutter#177586, the pre-launch checklist, is down to removing TODOs from doc snippets and dropping the `invalid_use_of_internal_member` ignores from the examples. Nothing on it is architectural. Build against the shape of this API, keep it behind an interface, and the day it ships on stable your migration is an import change.

## Related

- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey is a good reminder: Flutter desktop apps need architecture first, polish later](/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## Sources

- [flutter/flutter#30701, the multi-window tracking issue](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586, the multi-window pre-launch checklist](https://github.com/flutter/flutter/issues/177586)
- [`packages/flutter/lib/src/widgets/_window.dart` at the 3.44.0 tag](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`packages/flutter_tools/lib/src/features.dart`, where `windowingFeature` is declared](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [Flutter's `examples/multiple_windows` reference app](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Flutter 3.44.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Canonical on bringing multiple windows to Flutter desktop](https://canonical.com/blog/multiple-window-flutter-desktop)
- [`desktop_multi_window` on pub.dev](https://pub.dev/packages/desktop_multi_window)
