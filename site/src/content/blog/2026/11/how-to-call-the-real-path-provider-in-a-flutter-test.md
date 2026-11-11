---
title: "How to call the real path_provider in a Flutter test instead of getting MissingPluginException"
description: "flutter test never runs the Dart plugin registrant, so getTemporaryDirectory() hits the MethodChannel default and throws MissingPluginException. On a macOS, Windows or Linux host you can register the host implementation (PathProviderFoundation 2.6.0+ is FFI, not a channel), use a temp-dir PathProviderPlatform fake, or run integration_test on desktop. Checked on Flutter 3.44.8 with path_provider 2.1.6."
pubDate: 2026-11-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "path-provider"
  - "plugins"
---

**Short answer:** `flutter test` does not run the generated Dart plugin registrant, so `PathProviderPlatform.instance` stays the `MethodChannelPathProvider` default and every call goes to a channel with no host code behind it. To get real paths in a unit or widget test, add the host's implementation package as a dev dependency and call its `registerWith()` before the test (`PathProviderFoundation.registerWith()` on macOS, `PathProviderWindows.registerWith()` on Windows, `PathProviderLinux.registerWith()` on Linux). On macOS this only works with `path_provider_foundation` 2.6.0 or newer, because older versions talk to Swift over Pigeon and fail with a `channel-error`. If you want real files but not your real home directory, register a small `PathProviderPlatform` subclass that points at a temp folder instead, and if you need the paths your app actually gets, run the test with `integration_test` on desktop.

Everything below was run for this post on Flutter 3.44.8 (Dart 3.12.2, macOS arm64, Xcode 27) with `path_provider` 2.1.6, `path_provider_foundation` 2.6.0 (and 2.4.4 for the "before" case), `path_provider_platform_interface` 2.1.3, `path_provider_windows` 2.3.0 and `path_provider_linux` 2.2.2. The Windows and Linux branches of the helper were compiled and type-checked on macOS but not executed on those operating systems.

## What the Stack Overflow asker wanted

The question [How to use the real PathProvider in a flutter test?](https://stackoverflow.com/questions/79914882) is a test that calls `getTemporaryDirectory()` on Windows and dies with:

```text
MissingPluginException(No implementation found for method getTemporaryDirectory on channel plugins.flutter.io/path_provider)
```

The asker explicitly does not want a mock: the code under test does a lot of disk I/O and real paths are fine. They noticed that during a test the instance is a `MethodChannelPathProvider`, while in the running app it is `PathProviderWindows`, and asked how to get the same provider the app uses. The accepted answer registers the platform packages by hand, then adds that some `await File.stat()` and `await Directory.create()` calls "hung" and had to be replaced with synchronous versions. Both parts have a concrete explanation, and the hang is not caused by path_provider at all.

## Why flutter test has no path_provider implementation

`path_provider` is a [federated plugin](https://docs.flutter.dev/packages-and-plugins/developing-packages#federated-plugins). The package you depend on contains only the public functions (`getTemporaryDirectory()` and friends), and they forward to `PathProviderPlatform.instance`. In `path_provider_platform_interface` 2.1.3 that static field starts out as:

```dart
// path_provider_platform_interface 2.1.3, lib/path_provider_platform_interface.dart
static PathProviderPlatform _instance = MethodChannelPathProvider();
```

and `MethodChannelPathProvider` sends `getTemporaryDirectory` over `MethodChannel('plugins.flutter.io/path_provider')`.

When you `flutter run` the app, the tool generates a Dart plugin registrant that calls each implementation package's `dartPluginClass.registerWith()` for the target platform. Every current path_provider implementation declares one: `PathProviderFoundation`, `PathProviderAndroid`, `PathProviderWindows`, `PathProviderLinux`. That registration is what swaps the channel default for the real implementation.

`flutter test` does not do that. It compiles your test file and runs it in the `flutter_tester` host process with no app, no embedder plugins, and no generated registrant. The [Plugins in Flutter tests](https://docs.flutter.dev/testing/plugins-in-tests) page says the host side of a plugin is only built and registered as part of an application build, so unit and widget tests get `MissingPluginException`. Even calling `DartPluginRegistrant.ensureInitialized()` from `dart:ui` inside the test does not help, because there is nothing for it to run:

```dart
// Flutter 3.44.8, path_provider 2.1.6
import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('default instance', () async {
    print('instance: ${PathProviderPlatform.instance.runtimeType}');
    try {
      await getTemporaryDirectory();
    } catch (e) {
      print('error: $e');
    }
  });

  test('DartPluginRegistrant.ensureInitialized', () async {
    DartPluginRegistrant.ensureInitialized();
    print('after registrant: ${PathProviderPlatform.instance.runtimeType}');
  });
}
```

Output on Flutter 3.44.8:

```text
instance: MethodChannelPathProvider
error: MissingPluginException(No implementation found for method getTemporaryDirectory on channel plugins.flutter.io/path_provider)
after registrant: MethodChannelPathProvider
```

So the fix is always the same idea: put a different object into `PathProviderPlatform.instance` before the code under test runs. The choice is which object.

## Why registering the host implementation works now

Registering an implementation package by hand only helps if that implementation does not need native code that `flutter_tester` lacks. That used to be true only on Windows and Linux:

- `path_provider_windows` 2.3.0 calls `SHGetKnownFolderPath` through `dart:ffi`. No channel.
- `path_provider_linux` 2.2.2 reads the XDG directories through `xdg_directories` and asks GLib's `libgio` for the application ID over `dart:ffi`. No channel.
- `path_provider_foundation` (iOS and macOS) was a Pigeon plugin backed by Swift until the 2.5/2.6 line. Its [changelog](https://pub.dev/packages/path_provider_foundation/changelog) for 2.6.0 reads "replaces Flutter-plugin-based implementation with direct FFI calls to Foundation". 2.5.0 did the same and was retracted, 2.5.1 reverted to Pigeon, and 2.6.0 re-released the FFI version. It requires Flutter 3.38.4 / Dart 3.10.

The version matters. Here is the same test with `path_provider_foundation` pinned to 2.4.4 through `dependency_overrides`:

```text
instance: PathProviderFoundation
PlatformException(channel-error, Unable to establish connection on channel: "dev.flutter.pigeon.path_provider_foundation.PathProviderApi.getDirectoryPath"., null, null)
```

The registration succeeds, but the first call fails because the Pigeon channel has no Swift host on the other side. With 2.6.0 the same test returns real paths, since `PathProviderFoundation` opens `/System/Library/Frameworks/Foundation.framework/Foundation` with `DynamicLibrary.open` and calls `NSSearchPathForDirectoriesInDomains` directly.

`path_provider_android` 2.3.0 moved to JNI, which also means "no channel", but that is irrelevant here: `flutter test` runs on your desktop OS, never on Android or iOS, so the implementation you can register is always the one for the machine running the tests.

## How to register the real path_provider in a unit test

1. Add the implementation packages as **dev** dependencies, so they are importable from `test/` without leaking into your app's dependency list (and without tripping the `depend_on_referenced_packages` lint):

```bash
flutter pub add dev:path_provider_foundation dev:path_provider_windows dev:path_provider_linux
```

2. Put the platform switch in one helper under `test/`:

```dart
// test/support/real_path_provider.dart
// Flutter 3.44.8, path_provider_foundation 2.6.0,
// path_provider_windows 2.3.0, path_provider_linux 2.2.2
import 'dart:io';

import 'package:path_provider_foundation/path_provider_foundation.dart';
import 'package:path_provider_linux/path_provider_linux.dart';
import 'package:path_provider_windows/path_provider_windows.dart';

/// Swaps the MethodChannel default for the implementation the app
/// would get on the host OS that runs `flutter test`.
void useHostPathProvider() {
  if (Platform.isMacOS) {
    PathProviderFoundation.registerWith();
  } else if (Platform.isWindows) {
    PathProviderWindows.registerWith();
  } else if (Platform.isLinux) {
    PathProviderLinux.registerWith();
  } else {
    throw UnsupportedError(
        'No host path_provider for ${Platform.operatingSystem}');
  }
}
```

Importing all three packages is safe on any host. Their native libraries (`kernel32.dll` and friends on Windows, `libgio-2.0.so.0` on Linux, Foundation on macOS) are opened from lazily initialized top-level `final`s or on first call, so nothing Windows-specific is touched when the test runs on macOS. On macOS this helper ran with all three imports in place; the Windows and Linux branches were not executed.

3. Call it from `setUpAll` in each test file that needs it:

```dart
// Flutter 3.44.8, path_provider 2.1.6
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider/path_provider.dart';

import 'support/real_path_provider.dart';

void main() {
  setUpAll(useHostPathProvider);

  test('real paths in test()', () async {
    final tmp = await getTemporaryDirectory();
    print('temp: ${tmp.path}');
    print('docs: ${(await getApplicationDocumentsDirectory()).path}');
    print('support: ${(await getApplicationSupportDirectory()).path}');

    final f = File('${tmp.path}/pp_probe.txt');
    await f.writeAsString('hi');
    print('async write ok: ${await f.readAsString()}');
    await f.delete();
  });
}
```

On macOS with `path_provider_foundation` 2.6.0 that printed (user name replaced):

```text
temp: /Users/<you>/Library/Caches
docs: /Users/<you>/Documents
support: /Users/<you>/Library/Application Support
async write ok: hi
```

Async file I/O works fine here. Note that these are **not** the paths your app gets. More on that under the gotchas.

`PathProviderPlatform.instance` is a static, so the registration lasts for the rest of that test file. Each test file runs in its own isolate under `flutter test`, so it does not leak into other files, but it does leak between tests in the same file: register in `setUpAll` or `setUp` of every file that needs it rather than relying on order.

## Why the accepted answer's async calls hung: testWidgets fakes time

The second half of the accepted answer ("I had to replace `await File.stat()` and `await Directory.create()` with synchronous equivalents, otherwise the test was hanging") is a `testWidgets` issue, not a path_provider one. `testWidgets` runs the body inside a `FakeAsync` zone driven by `AutomatedTestWidgetsFlutterBinding`. Futures that complete from real I/O are delivered by the real event loop, which the fake zone does not pump, so the `await` never resumes.

This reproduces it:

```dart
// Flutter 3.44.8, path_provider_foundation 2.6.0 registered in setUpAll
testWidgets('real I/O inside testWidgets without runAsync', (tester) async {
  final dir = await getTemporaryDirectory();
  final f = File('${dir.path}/pp_probe2.txt');
  print('before write');
  await f.writeAsString('hi').timeout(const Duration(seconds: 5));
  print('after write');
}, timeout: const Timeout(Duration(seconds: 20)));
```

```text
before write
TimeoutException after 0:00:20.000000: Test timed out after 20 seconds.
```

Three details from that run are worth knowing:

- `getTemporaryDirectory()` itself returned. With the FFI implementation the lookup is synchronous under an `async` wrapper, so it completes inside the fake zone. Only the real file write hangs.
- The file **was written** to disk. The I/O finished; only the continuation after `await` never ran.
- The `.timeout(5 seconds)` never fired either, because that timer lives on the fake clock. Only the outer test-runner timeout ended the test.

The fix is `tester.runAsync`, which runs a callback outside the fake zone and waits for it:

```dart
// Flutter 3.44.8
testWidgets('real I/O inside testWidgets with runAsync', (tester) async {
  final text = await tester.runAsync(() async {
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/pp_probe3.txt');
    await f.writeAsString('hi');
    return f.readAsString();
  });
  expect(text, 'hi');
});
```

That passes. Use plain `test()` for code that does real I/O and has no widgets, and `tester.runAsync` for the I/O parts of a widget test. Switching to `File.writeAsStringSync` also "works", but it changes the code under test to fit the harness, which is the wrong direction. If you already freeze time in widget tests, the same fake-zone rules are covered in more depth in [testing a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/).

## A temp-directory fake: real files, isolated paths

If the reason you want "real" path_provider is real disk I/O, you usually do not want it in your real `~/Documents`. A subclass of `PathProviderPlatform` that hands out folders under a fresh temp directory gives you real files with nothing to clean up by hand:

```dart
// test/support/fake_path_provider.dart
// Flutter 3.44.8, path_provider_platform_interface 2.1.3
import 'dart:io';

import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

/// Real directories on disk, but under a throwaway root per test run.
class TempDirPathProvider extends PathProviderPlatform {
  TempDirPathProvider(this.root);

  final Directory root;

  Future<String> _dir(String name) async {
    final d = Directory('${root.path}/$name');
    await d.create(recursive: true);
    return d.path;
  }

  @override
  Future<String?> getTemporaryPath() => _dir('tmp');
  @override
  Future<String?> getApplicationSupportPath() => _dir('support');
  @override
  Future<String?> getApplicationDocumentsPath() => _dir('documents');
  @override
  Future<String?> getApplicationCachePath() => _dir('cache');
  @override
  Future<String?> getLibraryPath() => _dir('library');
  @override
  Future<String?> getDownloadsPath() => _dir('downloads');
}
```

```dart
// Flutter 3.44.8, path_provider 2.1.6
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

import 'support/fake_path_provider.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('pp_test_');
    PathProviderPlatform.instance = TempDirPathProvider(root);
  });

  tearDown(() => root.delete(recursive: true));

  test('documents dir lives under the temp root', () async {
    final docs = await getApplicationDocumentsDirectory();
    await File('${docs.path}/a.txt').writeAsString('x');
    expect(docs.path, startsWith(root.path));
  });
}
```

On macOS the documents folder came back as `/var/folders/.../T/pp_test_GdDMt4/documents`, and the test passed. This is the "mock the plugin's platform interface" option from the Flutter docs, with real directories instead of canned strings.

Notes on the fake:

- `extends PathProviderPlatform` passes the platform-interface token check on its own, because the base constructor supplies it. `MockPlatformInterfaceMixin` from `plugin_platform_interface` is only required when a class uses `implements PathProviderPlatform` (for example a mocktail `Mock`). Using `implements` without it fails at assignment with `AssertionError: Platform interfaces must not be implemented with 'implements'`. Both cases were checked in the same run.
- Any method you do not override throws. `getExternalStorageDirectory()` against this fake gave `UnimplementedError: getExternalStoragePath() has not been implemented.` That is useful: Android-only paths fail loudly instead of returning a desktop folder that pretends to be external storage.
- `Directory('${root.path}/$name')` works on Windows too, because `dart:io` accepts forward slashes, so the fake has no dependency on `package:path`.

## Mocking the channel instead

The lowest-level option is answering the method channel yourself. It needs no extra dependency, which makes it handy in a package that cannot add dev dependencies:

```dart
// Flutter 3.44.8, path_provider 2.1.6
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall call) async => '/tmp/pp_channel/${call.method}',
    );
  });
}
```

`getTemporaryDirectory()` then returns `/tmp/pp_channel/getTemporaryDirectory`. This only works while the default `MethodChannelPathProvider` is in place: once anything registers a real implementation, the channel is no longer used and your handler is silently bypassed. The Flutter docs rank this option last for that reason, and it depends on the channel and method names, which are internal details of the plugin.

## integration_test on desktop: the paths the app really uses

If the test is about what the app does with its real directories, run it as an integration test on the desktop target. That goes through a real app build, so the generated registrant runs and the macOS sandbox applies:

```dart
// integration_test/paths_test.dart
// Flutter 3.44.8, path_provider 2.1.6
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('real app paths', (tester) async {
    final tmp = await getTemporaryDirectory();
    await tmp.create(recursive: true); // not guaranteed to exist on macOS
    final f = File('${tmp.path}/it_probe.txt');
    await f.writeAsString('hi');
    expect(await f.readAsString(), 'hi');
    await f.delete();
  });
}
```

```bash
flutter pub add 'dev:integration_test:{"sdk":"flutter"}'
```

```bash
flutter test integration_test -d macos
```

With the default `com.example.ppTest` bundle ID the paths were:

```text
temp: /Users/<you>/Library/Containers/com.example.ppTest/Data/Library/Caches/com.example.ppTest
docs: /Users/<you>/Library/Containers/com.example.ppTest/Data/Documents
support: /Users/<you>/Library/Containers/com.example.ppTest/Data/Library/Application Support/com.example.ppTest
```

Compare that with the unit-test output above. Async I/O inside this `testWidgets` worked without `runAsync`, because `IntegrationTestWidgetsFlutterBinding` uses the real clock. The incremental macOS build plus test took about 18 seconds of wall time on an M-series Mac. Use `-d windows` or `-d linux` on those hosts.

Two things went wrong on the first run, and both will hit a freshly created project:

- Xcode 27 refused to build the `flutter create` template: "The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.15, but the range of supported deployment target versions is 12.0 to 27.2.x." Raise `MACOSX_DEPLOYMENT_TARGET` to 12.0 in `macos/Runner.xcodeproj/project.pbxproj` (and in your `Podfile` platform line if you use CocoaPods).
- The first write threw `PathNotFoundException ... errno = 2`. On a fresh sandbox container `getTemporaryDirectory()` returned a `Caches/<bundle id>` path that did not exist yet: `path_provider_foundation` 2.6.0 creates the directory for `getApplicationSupportDirectory()` and `getApplicationCacheDirectory()`, but not for `getTemporaryDirectory()`. Create it before writing, in the app as well as in tests.

## Gotchas with the real host implementation

- **You are writing into your real home folder.** In a unit test the macOS implementation returned `~/Documents` and `~/Library/Caches` directly. Files your code under test creates there survive the run, and on CI they pile up on the agent between jobs.
- **The paths are not your app's paths.** In the app, `path_provider_foundation` appends the bundle identifier to Application Support and Caches on macOS, and the sandbox redirects everything into `~/Library/Containers/<bundle id>/`. `flutter_tester` has no bundle identifier and no sandbox, so in a unit test `getApplicationSupportDirectory()` is the shared `~/Library/Application Support`. Code that assumes "my support dir is empty on first launch" behaves differently.
- **iOS paths cannot be tested this way.** `Platform.isIOS` is false in `flutter test` on a Mac; you get macOS directories. The same goes for Android-only methods such as `getExternalStorageDirectory()`, which throws `UnsupportedError` on the Foundation implementation.
- **Pin the minimum version.** If a teammate's lock file resolves `path_provider_foundation` below 2.6.0 (for example a project still on Flutter older than 3.38.4), the helper still compiles and then fails with the Pigeon `channel-error` above. Put `path_provider_foundation: ^2.6.0` in `dev_dependencies` so `pub get` fails early instead.
- **Prefer wrapping for app logic.** The Flutter docs rank "wrap the plugin in your own API" first, and for code you own that is still the best default: inject a `Future<Directory> Function()` or a small storage service, and tests pass a temp directory without touching `PathProviderPlatform` at all. Registering the host implementation is the right tool when the call happens inside a package you do not control, or when the test is explicitly about real file-system behaviour.

## Related posts

- If a plugin works in debug but throws `MissingPluginException` in a release build, the cause is different (R8/ProGuard or registration); see [how to fix MissingPluginException: No implementation found for method getAll](/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- [shared_preferences vs a JSON file for persisting settings in Flutter](/2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter/) uses the `path_provider` documents directory for the JSON-file approach, which is exactly the kind of code these tests exercise.
- [Migrating a Flutter app from Hive to Drift](/2026/10/migrate-a-flutter-app-from-hive-to-drift/) places its database file with `path_provider`, and the temp-dir fake above is a clean way to test that setup.
- For a channel you own rather than a plugin, [adding platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) shows the host side that `flutter test` never loads.
- The `testWidgets` fake clock that caused the hang is the same one discussed in [testing a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/).

## Sources

- [Stack Overflow: How to use the real PathProvider in a flutter test?](https://stackoverflow.com/questions/79914882)
- [Flutter docs: Plugins in Flutter tests](https://docs.flutter.dev/testing/plugins-in-tests)
- [Flutter docs: Integration testing](https://docs.flutter.dev/testing/integration-tests)
- [`path_provider_foundation` changelog](https://pub.dev/packages/path_provider_foundation/changelog) (2.5.0 FFI, 2.5.1 revert, 2.6.0 FFI re-release)
- [`path_provider` source in flutter/packages](https://github.com/flutter/packages/tree/main/packages/path_provider)
- [`plugin_platform_interface` README](https://pub.dev/packages/plugin_platform_interface) (`MockPlatformInterfaceMixin`)
- [`WidgetTester.runAsync` API reference](https://api.flutter.dev/flutter/flutter_test/WidgetTester/runAsync.html)
- [`TestDefaultBinaryMessenger.setMockMethodCallHandler` API reference](https://api.flutter.dev/flutter/flutter_test/TestDefaultBinaryMessenger/setMockMethodCallHandler.html)
