---
title: "kDebugMode vs assert: which one strips debug-only code from a Flutter release build?"
description: "Both if (kDebugMode) and assert(() { ... }()) remove debug-only code from Flutter profile and release builds. Measured on Flutter 3.44.8 across Android, macOS and web builds, plus the cases where the code still ships: runtime flags, call-site strings, !kReleaseMode, and plugins."
pubDate: 2026-11-19
template: vs
tags:
  - "flutter"
  - "dart"
  - "comparison"
  - "release-builds"
  - "app-size"
---

Short answer: for keeping code out of a shipped Flutter app, `if (kDebugMode) { ... }` and `assert(() { ... return true; }())` are equally reliable. Both blocks were completely absent from release builds for Android, macOS and web, and from an Android profile build, on Flutter 3.44.8 (Dart 3.12.2). Prefer `if (kDebugMode)` for debug-only behavior, because it reads like normal code, supports `else` and `await`, and does not need the `return true` trick. Keep `assert` for invariants. What actually leaks into release builds is code that is guarded by something the compiler cannot see as a constant, strings passed as arguments to a function that checks the flag internally, `!kReleaseMode` blocks in profile builds, and the native and Dart platform code of any plugin you depend on, even if you only call it in debug.

This question comes up because the `assert` closure pattern was the advice for years, and the `kDebugMode` constant in `package:flutter/foundation.dart` came later. Developers who adopted the assert idiom early reasonably ask whether switching gives up any guarantee. It does not, but the reason is different for each, and that difference matters in a few edge cases.

## The two approaches side by side

| | `assert(() { ... return true; }())` | `if (kDebugMode) { ... }` |
| --- | --- | --- |
| Runs in `flutter run` (debug) | yes | yes |
| Runs in `flutter test` | yes | yes (`kDebugMode` is `true`) |
| In a profile build | removed | removed |
| In a release build (APK, macOS, web) | removed | removed |
| Controlled by | the `--enable-asserts` compiler flag | the `dart.vm.product` and `dart.vm.profile` defines |
| `else` branch | no | yes |
| Can `await` inside | no, the closure must return `bool`, not `Future<bool>` | yes |
| Must return a value | yes, `true`, or debug runs throw `AssertionError` | no |
| Skipped by `--dart-define=dart.vm.product=true` in debug | no, still runs | yes |

All "removed" cells are measured, not assumed. The setup and raw results are below.

## Why each one disappears from a release build

They get removed for two different reasons.

`kDebugMode` is a plain Dart compile-time constant. In Flutter 3.44.8 it is defined in `packages/flutter/lib/src/foundation/constants.dart` as:

```dart
// Flutter 3.44.8, package:flutter/foundation.dart
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

The Flutter tool passes `-Ddart.vm.product=true` for release builds and `-Ddart.vm.profile=true` for profile builds (see `buildModeOptions` in `flutter_tools/lib/src/compile.dart`). With those defines, `kDebugMode` evaluates to `false` at compile time. The Dart VM's AOT pipeline then runs a kernel transformation, `unreachable_code_elimination.dart`, whose `visitIfStatement` replaces an `if` with a constant condition by the branch that can run. A `false` condition with no `else` is replaced by an empty statement. The same pass folds `!`, `&&`, `||` and `?:` when their operands are constants.

`assert` is removed by the same pass for a different reason. Its `visitAssertStatement` and `visitAssertBlock` return an empty statement when `enableAsserts` is false, without looking at the condition at all. Flutter only adds `--enable-asserts` to the compiler options in debug mode. The Dart language docs say the same thing from the other side: in production code, assertions are ignored and their arguments are not evaluated.

After either removal, nothing references the code that was inside the block anymore. Tree shaking then drops any function, class or constant that was only reachable from it. That is why the second half of the question, "the code is never included in any APK/IPA", holds for both.

## The measurement

The test app is a fresh `flutter create` project with probe strings in `main.dart`. Each probe has a unique marker, so `strings` on the compiled AOT snapshot shows exactly which code survived. Environment: Flutter 3.44.8 stable (framework revision `058e0af2c2`), Dart 3.12.2, Android Gradle Plugin 9.0.1, Xcode 27.2, on an Apple Silicon Mac. The probes:

```dart
// Flutter 3.44.8, Dart 3.12.2
// ignore_for_file: avoid_print
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'debug/assert_tools.dart'; // class AssertOnlyInspector, prints PROBE_ASSERT_CLASS_BODY
import 'debug/kdebug_tools.dart'; // class KDebugOnlyInspector, prints PROBE_KDEBUG_CLASS_BODY

const bool constAlias = kDebugMode;
final bool finalAlias = kDebugMode;
bool mutableAlias = kDebugMode;
bool get getterAlias => kDebugMode;
bool showDevMenu = kDebugMode; // also written at runtime below

const String debugOnlyUrl = 'https://PROBE_CONST_URL.example';

@pragma('vm:never-inline')
void maybeLog(bool enabled, String message) {
  if (enabled) print(message);
}

@pragma('vm:never-inline')
bool runtimeFlag() => DateTime.now().millisecond >= 0;

void main() {
  assert(() {
    print('PROBE_ASSERT_CLOSURE');
    AssertOnlyInspector().install();
    return true;
  }());

  if (kDebugMode) {
    print('PROBE_KDEBUG_IF');
    KDebugOnlyInspector().install();
    print(debugOnlyUrl);
  }

  assert(runtimeFlag(), 'PROBE_ASSERT_MESSAGE');
  if (!kReleaseMode) print('PROBE_NOT_RELEASE');

  if (constAlias) print('PROBE_CONST_ALIAS');
  if (finalAlias) print('PROBE_FINAL_ALIAS');
  if (mutableAlias) print('PROBE_MUTABLE_ALIAS');
  if (getterAlias) print('PROBE_GETTER_ALIAS');
  if (kDebugMode && runtimeFlag()) print('PROBE_KDEBUG_AND_RUNTIME');
  if (runtimeFlag() && kDebugMode) print('PROBE_RUNTIME_AND_KDEBUG');
  print(kDebugMode ? 'PROBE_TERNARY_DEBUG' : 'release-label');

  debugPrint('PROBE_UNGUARDED_DEBUGPRINT');

  if (DateTime.now().year > 3000) showDevMenu = true;
  if (showDevMenu) print('PROBE_RUNTIME_MUTATED');

  maybeLog(kDebugMode, 'PROBE_CALLSITE_ARGUMENT');
  maybeLog(runtimeFlag(), 'runtime-log');

  runApp(const MaterialApp(home: Scaffold(body: Text('probe'))));
}
```

The full file also has a `static const` field, an instance field initialized from `kDebugMode`, and a `const bool.fromEnvironment('DEV_TOOLS')` check. It was built and inspected with:

```bash
flutter build apk --release --target-platform android-arm64
unzip -o -q build/app/outputs/flutter-apk/app-release.apk lib/arm64-v8a/libapp.so -d release
strings -n 6 release/lib/arm64-v8a/libapp.so | grep -oE "PROBE_[A-Z_]+|AssertOnlyInspector|KDebugOnlyInspector" | sort | uniq -c

flutter build macos --release
strings -n 6 build/macos/Build/Products/Release/strip_probe.app/Contents/Frameworks/App.framework/Versions/A/App | grep -oE "PROBE_[A-Z_]+" | sort | uniq -c

flutter build web --release
grep -oE "PROBE_[A-Z_]+" build/web/main.dart.js | sort | uniq -c
```

Results ("present" means the marker string is in the compiled output):

| Probe | Release APK (arm64) | macOS release | Web release (dart2js) |
| --- | --- | --- | --- |
| `assert(() { ... }())` body and the class it uses | absent | absent | absent |
| `if (kDebugMode)` body, its class and its `const` URL | absent | absent | absent |
| `assert` message string | absent | absent | absent |
| `!kReleaseMode` | absent | absent | absent |
| `const`, `static const`, getter, `final`, never-written variable, instance field | absent | absent | absent |
| `kDebugMode && runtime()`, `runtime() && kDebugMode`, ternary | absent | absent | absent |
| Unguarded `debugPrint` | **present** | **present** | **present** |
| Variable also written at runtime (`showDevMenu`) | **present** | **present** | **present** |
| String passed to `maybeLog(kDebugMode, ...)` | **present** | **present** | absent |

A separate Android profile build (`flutter build apk --profile`) of the first nine probes matched the release column, with one exception: `PROBE_NOT_RELEASE` was present. That is expected and is the subject of the next section.

Running the macOS release binary directly confirmed the runtime side. It printed only three lines: `release-label`, `PROBE_UNGUARDED_DEBUGPRINT` and `runtime-log`.

## Where debug code still ships

The two guards themselves are not the problem. The leaks come from what surrounds them.

### `!kReleaseMode` is true in profile builds

`kReleaseMode` is only true in release builds, so `if (!kReleaseMode)` runs in both debug and profile. Profile builds are what you use to measure performance and what testers sometimes install through internal channels, so a debug-only overlay or log written as `!kReleaseMode` shows up there. The Flutter docs comment on `kReleaseMode` warns about exactly this and recommends `kDebugMode` or `assert`. Use `kDebugMode` when you mean "debug only".

### The compiler only folds what it can prove is constant

In this build, the `final` alias, the never-written `mutableAlias` and the instance field were all folded away. The `const` cases are folded by the kernel pass above. The others were removed by the AOT compiler's whole-program analysis, which noticed that the only value ever stored was `false`. That is an optimization, not a rule of the language, so do not rely on it.

`showDevMenu` shows the line. It starts as `kDebugMode`, but one line of code writes `true` to it based on a runtime condition. The compiler can no longer prove its value, and everything behind `if (showDevMenu)` ships. This is the common real-world shape: a `Config` or `FeatureFlags` object with an `isDebug` field that something can also set from remote config or a hidden settings screen. If a value must not ship, guard it with `kDebugMode` directly at the place where the code lives, not with a variable that is derived from it.

### Arguments are evaluated before the callee checks the flag

`maybeLog(kDebugMode, 'PROBE_CALLSITE_ARGUMENT')` kept the string in the Android and macOS snapshots. The call site is not inside a conditional. The string is a normal argument, and the check happens inside `maybeLog`, which also receives `true` from another call site. Logging helpers built this way leak their messages into release binaries, including URLs, tokens or internal endpoint names in those messages. dart2js happened to inline `maybeLog` on web and drop the string, because `@pragma('vm:never-inline')` only applies to the VM. That is again an optimization, not a guarantee.

If the message itself is sensitive, the check has to be at the call site:

```dart
// Flutter 3.44.8
if (kDebugMode) debugPrint('token refresh against $internalUrl');
```

### `print` and `debugPrint` are not stripped on their own

`debugPrint` sounds debug-only, but it is a normal function that prints in every mode. The macOS release binary above printed `PROBE_UNGUARDED_DEBUGPRINT` to stdout. On Android it ends up in logcat, where anyone with `adb` can read it. Wrap it in `kDebugMode` or use a logger with a level that you set from `kDebugMode`.

### Plugins ship even if you only call them in debug

This is the biggest leak in practice. Rebuild the probe app with `shared_preferences` 2.5.6 as a dependency, and call it only inside `if (kDebugMode)`:

```dart
// Flutter 3.44.8, shared_preferences 2.5.6
if (kDebugMode) {
  SharedPreferences.getInstance().then((p) => print('PROBE_PLUGIN ${p.getKeys()}'));
}
```

The Dart code behind the guard is gone, as expected: `PROBE_PLUGIN` and the app-facing `SharedPreferences` class are not in `libapp.so`. But the release APK still contains the following:

- `SharedPreferencesAndroid` and `SharedPreferencesStorePlatform` in the AOT snapshot. Flutter generates a Dart plugin registrant that calls `registerWith` for every federated implementation that declares a `dartPluginClass` (here `dartPluginClass: SharedPreferencesAndroid`), and it runs at startup whether or not your code uses the plugin.
- `io.flutter.plugins.sharedpreferences.SharedPreferencesPlugin` in `classes.dex`, because `GeneratedPluginRegistrant.java` instantiates every Android plugin, and R8 keeps whatever that registrant references.

Measured sizes for the same app with and without the dependency:

| Build (release, android-arm64) | APK bytes | `classes.dex` bytes |
| --- | --- | --- |
| Without `shared_preferences` | 14,883,068 | 522,496 |
| `shared_preferences` used only in `kDebugMode` | 15,684,180 | 859,440 |

That is about 800 KB of APK for a dependency that never runs in release. The macOS release build showed the same pattern, with `SharedPreferencesFoundation` in the `App` framework. Neither `kDebugMode` nor `assert` can fix this, because the guard only affects Dart code paths. The fix is at the dependency level: keep debug tools such as network inspectors in a separate entry point (`lib/main_dev.dart` run with `flutter run -t lib/main_dev.dart`) and make sure the release entry point and its pubspec do not depend on them. Or accept the cost knowingly, as with the [debug-only network inspector setup for Droido](/2026/02/flutter-droido-1-2-0-debug-only-network-inspector-with-zero-release-impact/), where the native side is small.

## The cases where the two actually behave differently

In every normal `flutter build` and `flutter run` invocation, `kDebugMode` and asserts change together. They are still separate switches, though, and you can split them.

`flutter_tools` only adds `-Ddart.vm.product=false` in debug mode when you have not set that define yourself. So this command runs a debug build where `kReleaseMode` is `true` and asserts are still enabled:

```bash
# Flutter 3.44.8
flutter test --dart-define=dart.vm.product=true test/modes_test.dart
```

```dart
// Flutter 3.44.8, test/modes_test.dart
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('mode constants and asserts under flutter test', () {
    var assertRan = false;
    assert(() {
      assertRan = true;
      return true;
    }());
    print('kDebugMode=$kDebugMode kProfileMode=$kProfileMode '
        'kReleaseMode=$kReleaseMode assertRan=$assertRan');
  });
}
```

Plain `flutter test` printed `kDebugMode=true kProfileMode=false kReleaseMode=false assertRan=true`, and the run with the define printed `kDebugMode=false kProfileMode=false kReleaseMode=true assertRan=true`. Some teams use this define to exercise release-only code paths in tests. If you do, `kDebugMode` blocks are skipped while `assert` blocks still run.

The other direction does not work. Forcing asserts into a release AOT build with the hidden `--extra-front-end-options=--enable-asserts` flag made the Flutter 3.44.8 Android release build fail in the compiler's unreachable code elimination pass, with `Constant evaluation error` on the framework's `defaultTargetPlatform`. In practice, release builds never run assert code.

The last difference is ergonomic, but it causes real bugs. The assert closure must return `true`. The snippet in the original question omits the return, and Dart 3.12.2 rejects it with `The expression in an assert must be of type 'bool'` (`non_bool_expression`). If you return `false` by mistake, the debug code runs and then throws a `Failed assertion` error, but release builds are fine, so the bug stays in debug. An `if (kDebugMode)` block has neither problem, and it can `await`, which an assert closure cannot.

## Which one to use

Use `if (kDebugMode)` for debug-only behavior: dev menus, verbose logging, `debugPaintSizeEnabled`, seeding fake data, attaching inspectors. It is removed as completely as `assert` in profile and release builds, it is ordinary control flow, and it states the intent. Use `assert` for what it was designed for: checking invariants that should hold in development and costing nothing in production. Rewriting existing `assert(() { ... }())` blocks has no size benefit, so convert them only when you touch them for another reason.

Either way, the guard only matters if it sits directly at the code you want removed. Check `kDebugMode` at the call site and not in a derived mutable flag. Never use `!kReleaseMode` to mean debug. Keep debug-only plugins out of the release dependency graph. If you want certainty for a specific secret or endpoint, do the same check this post does: `unzip` the `libapp.so` from your release APK, or open `App.framework/App` on Apple platforms, and `grep` for the string. If you build with `--obfuscate`, class names disappear from that output but string literals do not, so the check still works ([the DWARF and obfuscation warning post](/2026/11/fix-unobfuscated-dwarf-debugging-information-warning-in-flutter-android-builds/) covers those flags).

## Related

- [What a Flutter flavor is and how it differs from a build mode](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/) explains debug, profile and release, and how `kReleaseMode` reaches your code.
- [Fixing shared_preferences NoSuchMethodError in Android release builds](/2026/11/fix-shared-preferences-nosuchmethoderror-in-flutter-android-release-builds/) is another case where release builds behave differently because of R8 and plugin registration.
- [Catching uncaught async errors with runZonedGuarded and PlatformDispatcher](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/) shows a typical place for a `kDebugMode` switch between dumping to the console and reporting to a crash service.

## Sources

- [`constants.dart` (`kDebugMode`, `kProfileMode`, `kReleaseMode`) at Flutter 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/packages/flutter/lib/src/foundation/constants.dart)
- [`buildModeOptions` in `flutter_tools/lib/src/compile.dart` at Flutter 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/packages/flutter_tools/lib/src/compile.dart)
- [`unreachable_code_elimination.dart` in the Dart SDK at 3.12.2](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/vm/lib/transformations/unreachable_code_elimination.dart)
- [Dart language docs: `assert`](https://dart.dev/language/error-handling#assert)
- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Stack Overflow: Is kDebugMode as reliable as assert() for excluding code from release builds?](https://stackoverflow.com/questions/79911765)
