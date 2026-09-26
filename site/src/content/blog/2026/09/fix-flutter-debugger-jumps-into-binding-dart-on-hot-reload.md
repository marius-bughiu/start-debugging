---
title: "Fix: Flutter debugger jumps into binding.dart on hot reload with no error shown"
description: "A dwds bug in Flutter 3.35 web sent a fake pause on every hot reload. Upgrade to Flutter 3.38+, or switch VS Code back to 'Debug my code' so package frames are skipped."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
---

If you run a Flutter web app from VS Code or Android Studio and every hot reload opens `package:flutter/src/foundation/binding.dart` (usually around line 845) with no exception in sight, you are not doing anything wrong. It is a bug in dwds, the web debug service, that shipped with Flutter 3.35: during a hot reload it paused Chrome to re-register breakpoints and reported that internal pause to the IDE as a real one. It was fixed in dwds 25.1.0+1, which first reached stable in Flutter 3.38.0. Upgrade (current stable is 3.47.5). If you are stuck on 3.35.x, switch the VS Code debug mode in the status bar back to "Debug my code", or pass `--no-web-experimental-hot-reload`.

Everything below was checked against the Flutter 3.35.4, 3.35.7, 3.38.0, and 3.47.5 sources, the dwds 24.4.0+2 and 25.1.0+1 changelogs, and the Dart-Code 3.144 settings schema.

## The error in context

There is no error text, and that is the confusing part. You save a file (or press the hot reload button), the reload completes, and then the editor switches to a file you never opened:

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

The CALL STACK panel says the isolate is paused, but not on an exception or on a breakpoint. You press Continue, the app keeps running, and it happens again on the next reload. Some people see a different file instead, with a message rather than source:

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

Variants of the same report name `package:flutter/src/painting/decoration_image.dart` or `package:provider/src/devtool.dart`. That list turns out to be the best clue to what is going on.

The typical report is Flutter 3.35.4 or 3.35.5 on the stable channel, Dart 3.9.2, running on Chrome, debugged from VS Code. The same symptom was confirmed in Android Studio. Running `flutter run -d chrome` in a terminal does not show it, because nothing in a terminal jumps to a source file.

## Why the debugger stops in binding.dart

Flutter 3.35 turned on stateful hot reload for the web by default (the `--web-experimental-hot-reload` flag flipped to `defaultsTo: true`). To keep your breakpoints working across a reload, dwds pauses the JavaScript isolate in Chrome, re-registers breakpoints against the new code, and resumes. That pause is an implementation detail. The bug was that dwds 24.4.x always emitted a `PauseInterrupted` event when it paused, including this internal one.

The IDE cannot tell the difference. As Dart-Code maintainer Danny Tuppeny put it in [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693), the `PauseInterrupted` event sent during the reload "to DAP/VS Code looks like a legitimate pause". So VS Code does what it does on any pause: it picks the top frame of the call stack and opens that file.

Which file? Whatever Dart code was executing when Chrome paused. In a debug build Flutter posts VM service events constantly: `SchedulerBinding` sends `Flutter.Frame` after frames, service extensions send `Flutter.ServiceExtensionStateChanged`, and all of that funnels through one method in `BindingBase`:

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

In the 3.35.4 source, `developer.postEvent(eventKind, eventData);` is exactly line 845, which is why so many reports mention that line. The other files people land in are also `postEvent` callers: `decoration_image.dart` calls `developer.postEvent('Flutter.ImageSizesForFrame', ...)`, and `provider`'s `devtool.dart` posts its own events for the Provider DevTools extension. The pause lands on whoever happens to be talking to the VM service at that instant.

The "source reference is no longer valid" variant is the same pause with worse timing: the reload has just swapped in new scripts, so the script reference attached to the stale frame no longer resolves.

### Why only some developers saw it

VS Code only jumps to a paused frame if it counts as your code. Dart-Code decides that with two settings, both `false` by default:

- `dart.debugSdkLibraries`: marks `dart:*` libraries as debuggable.
- `dart.debugExternalPackageLibraries`: marks external pub packages as debuggable, and the Dart-Code schema is explicit that this includes `package:flutter`.

These are the same settings the status bar item cycles through while a debug session runs: "Debug my code", "Debug my code + packages", "Debug my code + packages + SDK". With the default "Debug my code", every frame in the fake pause belongs to `package:flutter`, none of them count as user code, and VS Code has nowhere to jump. If you had ever switched to "+ packages" to step into a framework method, `binding.dart` became "your" code and the editor jumped there on every reload. That is also why a Flutter team member first tested 3.35.6, saw no problem, and marked the issue fixed, before Danny pointed out that the recording was using "Debug my code".

## Minimal repro

You only need this if you want to confirm you are hitting this bug and not something else.

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

Select Chrome as the device, press F5, change the counter text in `lib/main.dart`, and save. On 3.35.x the editor opens `binding.dart` at the `developer.postEvent` line. Remove the setting (or pick "Debug my code" in the status bar) and the jump stops, although the isolate still pauses briefly. On Flutter 3.38.0 or later neither happens.

## Fix 1: upgrade to Flutter 3.38 or later

This is the real fix. The dwds change is [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695), "Don't send PauseInterrupted event during a hot reload", merged on October 9, 2025. Instead of sending a normal pause event, `ChromeProxyService` now tells the debugger the pause is internal, and the debugger signals completion through a completer rather than an event. It shipped as the dwds `25.1.0+1` hotfix, whose changelog entry reads "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" and links [dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560).

What matters for you is which dwds your Flutter SDK pins in `packages/flutter_tools/pubspec.yaml`:

| Flutter | dwds pinned | Fake pause on web hot reload |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | No (stateful web hot reload off by default) |
| 3.35.4 | 24.4.0+2 | Yes |
| 3.35.7 (last 3.35 hotfix) | 24.4.0+2 | Yes |
| 3.38.0 | 25.1.0+2 | No |
| 3.47.5 (stable, September 2026) | 27.1.2 | No |

The fix was never cherry-picked into the 3.35 line, so no 3.35 hotfix will help. Check what you are on and move forward:

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

If the project pins its SDK through FVM or a `.flutter-version` file, bump that instead, otherwise the IDE keeps launching the old SDK even after you upgrade the global one:

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

Then restart the debug session. A running session keeps its original `flutter run` process, and that process holds the old dwds.

## Fix 2: switch VS Code back to "Debug my code"

If you cannot upgrade yet (a locked CI image, a plugin that does not support newer Dart), hide the symptom. While a debug session is running, click the debug mode item on the left of the status bar and choose "Debug my code". Or set it for the workspace:

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

This is the workaround Danny recommended in the issue. The isolate still pauses briefly during the reload, but since every frame is in `package:flutter` or `dart:*`, VS Code treats them all as external code and does not steal focus. When you really need to step into a package, flip to "+ packages" for that session and accept the jumps until you flip back.

This does not help in Android Studio or IntelliJ, which have no equivalent toggle for this case. Use Fix 3 there.

## Fix 3: turn off stateful web hot reload on 3.35

The blunt option is to go back to the pre-3.35 web module format, which does not do the pause-and-re-register dance at all:

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

For VS Code, put it in `launch.json` so it applies only to this project:

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

The `dart.flutterRunAdditionalArgs` user setting also works, but it applies to every project on the machine, which is how people end up forgetting it is there a year later. In Android Studio, open Run > Edit Configurations, select the Flutter configuration, and put `--no-web-experimental-hot-reload` in "Additional run args".

The cost is real: without the new module format, the web target falls back to the older behaviour where a reload restarts the app and you lose state on every save. Treat this as a bridge until you can upgrade, and remove it afterwards. In Flutter 3.47.5 the flag's help text already says "(deprecated; will be removed in a future release)", so a leftover `toolArgs` entry will eventually break your launch configuration.

## Gotchas and lookalikes

**You are on 3.38 or later and it still happens.** Look at the header of the CALL STACK panel before anything else. If it says "Paused on exception", this is not the dwds bug, it is a real exception, and the Breakpoints panel will show "Uncaught Exceptions" or "All Exceptions" ticked. With "All Exceptions", the debugger also stops on exceptions that framework or package code throws and catches itself. Untick it, reload, and see if the pause goes away. If it says "Paused on breakpoint", open the Breakpoints panel: VS Code persists breakpoints per workspace, including ones you set inside `binding.dart` while stepping through the framework months ago. Remove it.

**It happens on Android, iOS, or desktop.** The fake pause was web-only, because it lived in dwds, which only runs for web targets. The native VM service does not pause the isolate to re-register breakpoints on reload. On a mobile or desktop target, a stop in `binding.dart` is an exception or a stray breakpoint, so use the checks above.

**Hot reload crashes the debug session instead of pausing.** Flutter 3.35.2 had a separate web bug where hot reload threw from `dwds/src/injected/client.js` and broke the session ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932)). Different bug, same cure: upgrade.

**The page shows old code after a reload.** If the reload "works" but the browser runs a stale build, you are looking at caching, not the debugger. See [why Flutter web serves a stale cached build after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**Hot reload hangs with a breakpoint set.** If you have a breakpoint inside a `State.reassemble` override (or code it calls), the `ext.flutter.reassemble` service call stops there on every reload, and the tool can time out waiting for it ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285)). That is a real breakpoint doing its job, not the dwds bug: continue past it or move it.

## Related

- If you are profiling rather than debugging, [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) covers the Performance view that consumes those `Flutter.Frame` events.
- [Why `appFlavor` goes null after a hot restart with `flutter attach`](/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) is another case where the reload path behaves differently from a normal launch.
- The [Dart and Flutter MCP server](/2026/05/dart-flutter-mcp-server-claude-code-cursor/) talks to the same VM service and DTD that dwds fronts on the web.
- Choosing a web renderer at the same time as upgrading? [CanvasKit vs skwasm for Flutter web in 2026](/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) walks through the trade-offs.

## Sources

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [dwds changelog on pub.dev](https://pub.dev/packages/dwds/changelog)
- [BindingBase.reassembleApplication API docs](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Flutter docs: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [What's new in Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)
