---
title: "Fix: flutter doctor reports cmdline-tools component is missing"
description: "Install the Android SDK Command-line Tools so the binaries land in <sdk>/cmdline-tools/latest/bin, point ANDROID_HOME at the SDK root, then re-run flutter doctor."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
---

The fix in one breath: `flutter doctor` is checking whether a directory named `cmdline-tools` exists directly under your Android SDK root, and it does not. In Android Studio open **Tools > SDK Manager > SDK Tools**, tick **Android SDK Command-line Tools (latest)**, click Apply. Without Android Studio, unzip the command-line tools archive so the binaries end up at `<sdk-root>/cmdline-tools/latest/bin`, set `ANDROID_HOME` to `<sdk-root>` (not to the `cmdline-tools` folder), then run `flutter doctor --android-licenses`. The "Android license status unknown" line underneath it is a consequence, not a second bug: the license tool is `sdkmanager`, and `sdkmanager` ships inside the package you are missing.

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

Everything below is verified against Flutter 3.44.7 stable (Dart 3.12.x), the stable channel as of 2026-08-06, with an Android SDK holding `cmdline-tools;19.0`, Build-Tools 36.0.0, Platform-Tools 37.0.0, and OpenJDK 21.0.11. The highest command-line tools revision on the stable channel today is 22.0.

## The check is a single directory test

It is worth knowing exactly how little the doctor is doing here, because it explains most of the confusing cases. In `packages/flutter_tools/lib/src/android/android_workflow.dart` the validator does this:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

And `cmdlineToolsAvailable` in `android_sdk.dart` is one line:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

No binary is executed. No version is parsed. Flutter takes the SDK root it resolved, appends `cmdline-tools`, and calls `existsSync()`. That means there are only two ways to see this message: the folder genuinely is not there, or Flutter resolved a different SDK root than the one you are looking at.

The second case is common enough that it is worth spelling out the resolution order Flutter uses, from `locateAndroidSdk()`:

1. The `android-sdk` key in Flutter's own config, set by `flutter config --android-sdk <path>`.
2. The `ANDROID_HOME` environment variable.
3. The `ANDROID_SDK_ROOT` environment variable, which Google has deprecated but Flutter still reads.
4. The platform default: `~/Android/Sdk` on Linux, `~/Library/Android/sdk` on macOS, `%LOCALAPPDATA%\Android\sdk` on Windows.
5. A last-ditch PATH scan for `aapt` (under `build-tools/<version>/`) or `adb` (under `platform-tools/`), inferring the root from wherever those live.

A stale `flutter config --android-sdk` from two laptops ago beats a perfectly correct `ANDROID_HOME`. `flutter doctor -v` prints the path it settled on, and that line is the one to read first.

Once the folder exists, a separate lookup finds the actual executable. `getCmdlineToolsPath` tries, in order:

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. the highest-numbered `cmdline-tools/<version>/bin/sdkmanager[.bat]`
3. `tools/bin/sdkmanager[.bat]`, the pre-2020 layout, which is skipped for `sdkmanager` because it is requested with `skipOldTools: true`

So `latest` is preferred but a versioned folder also works. That distinction matters in one of the gotchas below.

## Reproducing it in ten seconds

On a working machine, the error is a rename away:

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

That is the whole failure mode. It is also why "reinstall Android Studio" advice usually works for the wrong reason: a fresh Studio install happens to tick the command-line tools box, so the folder appears.

## Fix 1: install it from the Android Studio SDK Manager

This is the recommended path if you have Android Studio at all, because Studio also keeps the package updated.

1. **Tools > SDK Manager** (or the SDK Manager icon in the toolbar).
2. Select the **SDK Tools** tab.
3. Tick **Android SDK Command-line Tools (latest)**. While you are there, confirm **Android SDK Build-Tools** and **Android SDK Platform-Tools** are also ticked, since Flutter needs them too.
4. Click **Apply**, accept the license, wait for the download.
5. Run `flutter doctor --android-licenses` and accept everything, then `flutter doctor` again.

Note the "(latest)" suffix in the checkbox label. That is not decoration: it is what makes Studio install into `cmdline-tools/latest/` rather than a numbered folder.

## Fix 2: install it with sdkmanager, if you already have some version

If you have any command-line tools at all, even an old one, use them to install the current package:

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

On Windows the binary is `sdkmanager.bat`. If you want a reproducible CI pin rather than a moving target, name the revision explicitly:

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

There is an obvious circularity here: `sdkmanager` lives inside `cmdline-tools`, so if the package is missing you cannot use `sdkmanager` to install it. That is what Fix 3 is for.

## Fix 3: bootstrap the package by hand

This is the path for headless Linux boxes, containers, and anyone who does not want Android Studio. Download the "Command line tools only" archive from the Android Studio download page, then build the layout Google's tooling expects. The archive unzips to a folder literally called `cmdline-tools`, which is one level short of correct.

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

The target layout, which is what the SDK Manager documentation specifies:

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

For reference, `bin/` on a real 19.0 install (Windows, so `.bat` wrappers) contains:

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

Then persist the environment and put the tools on PATH:

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` must be the SDK root. Pointing it at `$HOME/Android/Sdk/cmdline-tools` or at `.../cmdline-tools/latest/bin` is the single most common self-inflicted version of this error, and it produces exactly the same message because `<that path>/cmdline-tools` does not exist.

Finally, install the rest of what Flutter wants and verify:

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` is the honest check. On the machine this post was written against it prints:

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## Fix 4: tell Flutter where the SDK actually is

If the folder exists and `sdkmanager --version` works but `flutter doctor` still complains, Flutter is looking somewhere else. Override the resolution order at step one:

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

Two traps here. `flutter config --android-studio-dir` is a different setting for the Studio installation, not the SDK, and pointing it at `.../cmdline-tools/latest/bin` is a documented way to end up back at this error. And `flutter config` writes to a user-level config file, so a value set once follows you into every project until you clear it with `flutter config --android-sdk ""`.

## Gotchas that look like the same error

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**. Every `sdkmanager` invocation on my machine prints this:

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

It is cosmetic. The installed package records `Pkg.Path=cmdline-tools;19.0` in its `source.properties`, but the SDK Manager placed it in `latest` because that is what the "(latest)" package means. `sdkmanager` still works, `flutter doctor` still passes. Do not "fix" it by renaming `latest` to `19.0`: Flutter would still find it through the versioned lookup, but Gradle's SDK auto-download and most CI scripts hardcode `cmdline-tools/latest/bin` and would break.

**Two `latest` folders**. If you see `latest` next to `latest-2`, the SDK Manager installed over a directory it could not replace, usually because a `sdkmanager` or `adb` process held a file handle. Delete `latest`, rename `latest-2` to `latest`, re-run `flutter doctor`.

**`ANDROID_SDK_ROOT` set but `ANDROID_HOME` empty**. Flutter reads both, preferring `ANDROID_HOME`. Gradle and the Android Gradle Plugin have been moving the other way for years, and some third-party tools now read only `ANDROID_HOME`. Set `ANDROID_HOME`; set `ANDROID_SDK_ROOT` to the same value only if something in your toolchain still needs it.

**A different message: "Android sdkmanager not found."** In full: `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` This is a later check, and it means the folder passed the existence test but no `sdkmanager` binary was found under `latest/bin` or any versioned `bin`. The usual cause is a nested unzip, `cmdline-tools/latest/cmdline-tools/bin/`, from moving the archive folder instead of its contents.

**A third message: "Android sdkmanager tool was found, but failed to run."** In full: `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` The binary exists and is executing; something inside it is throwing. Run it directly to see the real stack trace. The classic culprit is `JAVA_HOME` pointing at an old runtime, which surfaces as `UnsupportedClassVersionError` with "class file version 61.0" (Java 17) against a runtime that "recognizes class file versions up to 55.0" (Java 11). Command-line tools 11.0 and later are compiled for Java 17. Newer JDKs are fine in the other direction: 19.0 runs without complaint on OpenJDK 21.0.11, verified for this post.

**WSL and containers**. Do not point a Linux `ANDROID_HOME` at a Windows SDK through `/mnt/c`. The Linux binaries are not there, the executable bits are wrong, and you will chase the "sdkmanager not found" variant instead. Install a native SDK inside the Linux environment.

**CI runners**. On GitHub Actions, `android-actions/setup-android` installs the command-line tools and puts them on PATH before anything else runs, which removes this class of failure from the pipeline entirely. Pin the revision rather than tracking `latest` if you want builds from six months ago to still reproduce, the same reasoning that applies when you [target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**The licenses line does not clear on its own**. After the package is installed, `flutter doctor` will still report `Android license status unknown` until you run `flutter doctor --android-licenses` and accept each one. In a non-interactive shell, `yes | flutter doctor --android-licenses` does the job.

## Related

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- the next wall you hit once the toolchain validates and the build actually starts.
- [Fix: AndroidX conflict during Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- a dependency-level Android failure rather than an SDK-level one.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- where SDK pinning stops being optional.
- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- the Dart-side equivalent of a broken environment, with a very different diagnosis.
- [Fix: Gradle build failed to produce an .apk file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) -- the same Android SDK plumbing seen from the .NET side.

## Sources

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot), Flutter documentation, which shows the SDK Manager path for this exact doctor output.
- [sdkmanager](https://developer.android.com/tools/sdkmanager), Android Studio documentation, for the required `cmdline-tools/latest` layout, the `--install`, `--list_installed`, `--sdk_root` and `--channel` flags.
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools).
- `packages/flutter_tools/lib/src/android/android_workflow.dart` and `android_sdk.dart` on the [flutter/flutter](https://github.com/flutter/flutter) stable branch, for the validator text and the SDK resolution order.
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288), where the reporter had pointed a Flutter config path at `cmdline-tools/latest/bin` instead of the SDK root.
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413), a still-open report of the doctor missing a correctly laid-out SDK on Debian 12 with `ANDROID_SDK_ROOT` set and `ANDROID_HOME` unset.
- [android-actions/setup-android](https://github.com/android-actions/setup-android), for the CI approach.
