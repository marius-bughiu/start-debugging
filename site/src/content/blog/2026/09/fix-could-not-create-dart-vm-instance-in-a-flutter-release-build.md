---
title: "Fix: Could not create Dart VM instance in a Flutter release build after flutter upgrade"
description: "The release APK shipped without libapp.so. Flutter 3.44.0 to 3.44.4 could drop it: upgrade to 3.44.5 or later and split the combined subprojects block."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
---

Your release build does not contain the compiled Dart code. The engine looks for the AOT snapshot in `libapp.so`, finds nothing, and cannot boot the VM. After an upgrade to Flutter 3.44.0 through 3.44.4 the usual cause is a Gradle plugin regression that silently dropped `libapp.so` from the APK or app bundle. Run `unzip -l` on the APK to confirm, upgrade to Flutter 3.44.5 or later (3.47.3 is current stable), and split the combined `subprojects` block in `android/build.gradle` into two blocks.

Everything below was checked against the Flutter 3.44.x and 3.47.3 sources on GitHub, the 3.44 hotfix changelog, and the engine code that prints these lines.

## The error as logcat prints it

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

The app closes before `main()` runs. On 3.44 the native crash usually follows in `FlutterJNI.performNativeAttach`. Older engines added a fourth line, `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` The macOS variant of this failure prints `Isolate snapshot invalid and could not be inferred from settings.` at `dart_vm_data.cc(31)` instead of the VM snapshot line. That one has a different cause, covered further down.

The pattern that brings people to this page: debug builds and `flutter run` work fine, a fresh `flutter create` project works fine, and the release build of the real app crashes on launch. It started with nothing but `flutter upgrade`, and downgrading makes it go away.

## Why the engine cannot find a VM snapshot

A release build does not ship Dart source or kernel bytecode. `gen_snapshot` compiles your app ahead of time into a native shared library, `libapp.so` on Android and `App.framework` on iOS and macOS. That library exports the VM snapshot and isolate snapshot symbols, and the engine boots from them.

The first log line comes from `DartVMData::Create` in the engine. It first takes the snapshot the embedder passed in. If that is missing or invalid, it falls back to `DartSnapshot::VMSnapshotFromSettings`, which searches the libraries listed in `settings.application_library_paths` for the snapshot symbols. If that returns nothing, it logs the error and returns empty. The other two lines are its callers giving up. So "VM snapshot invalid" almost never means a corrupt snapshot. It means there was no AOT library to search.

That turns the question into: why does the package not contain `libapp.so`? In order of likelihood:

1. **The Flutter 3.44.0 to 3.44.4 Gradle regression.** `libapp.so` was dropped from APKs and app bundles in some project layouts. This is the one that shows up after `flutter upgrade`.
2. **`debuggable true` on the release build type.** The Flutter Gradle plugin then builds Dart in debug mode, so no AOT library is produced at all.
3. **macOS Big Sur running an app built with Flutter 3.44 or later.** The library is there, but the old dynamic loader cannot resolve symbols in the new Mach-O output.

## Confirm it: look inside the APK

Do not guess, check. This takes ten seconds:

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

A healthy APK lists both libraries for every ABI you ship:

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

The APK in [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), the main report of this regression, listed `libflutter.so` and `libdartjni.so` for all three ABIs and no `libapp.so` at all. That asymmetry is the signature. `libflutter.so` comes from an AAR dependency, so it survived. `libapp.so` came from a different path, so it did not.

For an app bundle, the paths live under `base/lib/`:

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

With flavors, the file name carries the flavor (`app-prod-release.apk`, `app-prodRelease.aab`). Check every ABI, not just arm64. In the flavor variant of the bug, one ABI can be present and the rest missing.

## What changed in Flutter 3.44

Before 3.44, the Flutter Gradle plugin delivered `libapp.so` inside a jar dependency. That hid it from AGP's native library stripping, so [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (merged 2026-01-26, shipped in 3.44.0 on 2026-05-15) moved it into a `jniLibs` source-set directory that the plugin populates. That change made `libapp.so` strippable, and it also made its delivery fragile in two ways, as described in the fix, [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119):

1. The `jniLibs` directory was resolved eagerly when `:app` was configured, but written lazily by the copy task. If `:app` was evaluated before its build directory was redirected, the two disagreed on where the build directory was, and the staged `libapp.so` was never merged. That happens with the old combined `subprojects` block plus any plugin whose Gradle project name sorts alphabetically before `app`.
2. The copy task wrote inside the Flutter task's own output directory. The overlapping outputs broke Gradle's up-to-date checks. In a flavored project, a `flutter run` on one device (one ABI) followed by a full `flutter build appbundle` left the other ABIs without `libapp.so` ([#187388](https://github.com/flutter/flutter/issues/187388)). A related report showed incremental flavored builds shipping the previous build's `libapp.so` ([#187553](https://github.com/flutter/flutter/issues/187553)).

App bundles failed louder. The same missing library shows up at build time as `Release app bundle failed to strip debug symbols from native libraries` ([#186810](https://github.com/flutter/flutter/issues/186810)). APKs have no such check, so they build cleanly and crash on the device.

## Minimal repro of the subprojects trigger

This is the layout the Flutter team encoded in the `gradle_libapp_so_packaging_test.dart` integration test that ships with the fix. A root `android/build.gradle` from an older template, with both statements in one block:

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

Add any plugin with native Android code whose name sorts before `app`, for example `android_intent_plus`, build with `flutter build apk --release` on 3.44.4, and the APK has no `libapp.so`. `subprojects {}` iterates projects alphabetically. `evaluationDependsOn(':app')` fires while processing the first plugin, which forces `:app` to configure before the loop has reached it and redirected its `buildDir`.

## Fix 1: upgrade to Flutter 3.44.5 or later

The fix landed on master on 2026-06-23 and was cherry-picked into [Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06). The 3.44.5 changelog entry reads: "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." It now stages `libapp.so` through a dedicated `CopyFlutterJniLibsTask` and registers the output with AGP's variant API, `variant.sources.jniLibs.addGeneratedSourceDirectory(...)`. AGP then owns the task dependency and resolves the path lazily, whatever the evaluation order.

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

Then run the `unzip` check again before shipping. If you have to stay on the 3.44 line, 3.44.5 through 3.44.9 all contain the fix. On 3.44.0 through 3.44.4, `flutter clean` alone only helps the flavor trigger, and only until the next single-device `flutter run`. It does nothing for the subprojects trigger.

If you pin Flutter in CI with FVM or a `.flutter-version` file, bump the pin too. A local `flutter upgrade` does not change the version your pipeline builds with, and that is how a crash that "is fixed on my machine" still reaches the Play Store. Pinning is still the right idea, as argued in [the post on reproducible Flutter builds](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/). Just move the pin on purpose.

## Fix 2: split the combined subprojects block

Do this even after upgrading. The combined block was removed from the template years ago ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030)) because it caused ordering bugs, and a Flutter maintainer noted on [#186810](https://github.com/flutter/flutter/issues/186810) that the combined syntax is probably still not supported in general, even though the 3.44 interaction is fixed. The Flutter 3.47.3 `android-kotlin` template's root `build.gradle.kts` looks like this:

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

If you are still on Groovy, the equivalent is:

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

Two blocks means every project's build directory is redirected before anything forces `:app` to evaluate. Also check for leftovers like a third `subprojects { afterEvaluate { ... compileSdkVersion ... } }` block that force-sets values on plugins. These go back to old Stack Overflow workarounds and tend to cause the next Gradle upgrade failure. When Gradle fails for real rather than silently, [the actual error is usually buried above the exit code line](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Fix 3: remove debuggable true from the release build type

This cause predates 3.44 and is still there on 3.47.3. The Flutter Gradle plugin picks the Dart build mode from the Android build type in `FlutterPluginUtils.buildModeFor`:

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

So this configuration compiles your Dart code in debug mode, with no `libapp.so`, while the rest of the pipeline still expects a release engine:

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

The result is the same three log lines. The report is [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), still open. Remove `isDebuggable = true` (`debuggable true` in Groovy) from `release`. If you wanted it to attach a native debugger to a signed build, use `flutter build apk --profile`, or add a separate build type for it and accept that it runs Dart in JIT mode. A custom build type such as `staging` without `isDebuggable` gets release-mode Dart, which is what you want there.

## The macOS Big Sur variant: Isolate snapshot invalid

If the log says `Isolate snapshot invalid and could not be inferred from settings.` and the machine is on macOS 11 Big Sur, the library exists and nothing is missing from the bundle. Starting with Flutter 3.44, `App.framework` on iOS and macOS is written directly by `gen_snapshot` (`--snapshot_kind=app-aot-macho-dylib`) instead of being linked by `ld64`. The new dylib has no exports trie and no table of contents. Big Sur's dyld (dyld-832) falls back to a binary search over the symbol table, which the new output does not satisfy. Some snapshot symbols then resolve and others do not, so the VM snapshot loads and the isolate snapshot fails. Monterey's dyld uses a linear search in that case and loads the same binary fine.

This was investigated in [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) and [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), and it will not be fixed. Flutter 3.47 lists Big Sur (11) and earlier as unsupported on the [supported platforms page](https://docs.flutter.dev/reference/supported-platforms), and the Flutter team does not cherry-pick into old stable lines. Your options are to stay on Flutter 3.41.x for builds that must run on Big Sur, or to raise `MACOSX_DEPLOYMENT_TARGET` to 12.0 and drop those users. A community workaround reorders the symbol table entries after the build and re-signs the framework. A Dart maintainer later said the analysis behind it was partly wrong (the missing piece is the table of contents, not symbol order), so I would not ship it.

You can inspect what your build produced with `nm`:

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## Lookalikes that are not this bug

- An iOS debug build dying at startup with `mprotect failed: 13 (Permission denied)` is the Dart VM failing too, but in JIT mode on iOS 26. That is [a separate fix: upgrade to Flutter 3.35 or later](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).
- A release build that launches fine and then misbehaves is past this point entirely: the VM booted. Losing Firebase sign-in only in release, for example, comes down to a different `google-services.json`, a rejected token refresh, or App Check. See [the release-only Firebase Auth fix](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).
- In a flavored app, `appFlavor` turning `null` after a hot restart is a tooling gap in `flutter attach`, not a packaging problem. See [keeping appFlavor populated after a hot restart](/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- Add-to-app modules built as AARs can hit the same three lines when the AAR was built in a different mode or on a patched Flutter checkout ([#114881](https://github.com/flutter/flutter/issues/114881)). Rebuild the AAR with `flutter build aar` from an unmodified SDK and check the AAR's `jni/` folder for `libapp.so`.

## Related

- What else moved in the release that introduced the regression: [Flutter 3.44 and the SwiftPM default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Gradle failures that do fail the build: [Gradle task assembleDebug failed with exit code 1](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Why pinning Flutter matters, and why you have to move the pin deliberately: [reproducible Flutter builds](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).
- The other Dart VM startup crash: [mprotect permission denied on iOS](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).

## Sources

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), the 3.44.1 report with the APK listing that showed `libapp.so` missing for every ABI.
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119), the fix, with the root cause write-up for both triggers.
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), the change that moved `libapp.so` out of a jar.
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) and [#187553](https://github.com/flutter/flutter/issues/187553), the app bundle and stale-flavor variants.
- [Flutter CHANGELOG, 3.44.5 hotfix](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md), which lists all three issues.
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), `debuggable true` on a release build type.
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) and [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), the Big Sur `App.framework` loading failure.
- Flutter engine source, `engine/src/flutter/runtime/dart_vm_data.cc` and `dart_snapshot.cc` on the `stable` branch, for where the log lines come from.
