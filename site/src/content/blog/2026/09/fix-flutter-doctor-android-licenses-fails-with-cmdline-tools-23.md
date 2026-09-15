---
title: "Fix: flutter doctor --android-licenses says 'The --licenses option is no longer needed' with cmdline-tools 23"
description: "cmdline-tools 23.0 retired sdkmanager --licenses, so Flutter before 3.47.3 reports license status unknown. Upgrade Flutter, or pin cmdline-tools 22.0."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
---

Your licenses are probably fine. Android SDK Command-line Tools 23.0 deprecated `sdkmanager`, and `sdkmanager --licenses` now prints a deprecation banner plus "Warning: The --licenses option is no longer needed." and exits 0 without prompting. Flutter up to 3.47.2 parses that output for a license count, finds none, and reports "Android license status unknown" no matter what is on disk. Upgrade to Flutter 3.47.3 or later (the fix is also in the 3.48 beta), which reads `<sdk>/licenses/` directly. If you cannot upgrade, install cmdline-tools 22.0 and make sure no newer copy is left in `cmdline-tools/`.

Everything below was reproduced on macOS with Flutter 3.44.8 and Flutter 3.47.3, cmdline-tools 22.0 and 23.0 side by side in a scratch SDK, and OpenJDK 17.0.20.1.

## The error as flutter doctor prints it

`flutter doctor -v` flags the Android toolchain even though everything else is green:

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

You do what it says, and instead of the familiar "Review licenses that have not been accepted (y/N)?" prompt you get this, followed by an immediate exit with code 0:

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

Run `flutter doctor` again and the "license status unknown" line is still there. That loop is the whole bug, reported as [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS, Flutter 3.47.1) and again as [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) and [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10, Flutter 3.47.2).

## Why Flutter cannot tell whether your licenses are accepted

Flutter's `AndroidLicenseValidator` does not read the license files itself. It runs `sdkmanager --licenses`, reads stdout line by line, and matches three regular expressions. This is the code in `packages/flutter_tools/lib/src/android/android_workflow.dart` at the 3.44.8 tag:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

If one of them matches, the status becomes `some`, `none`, or `all`. If none match, the validator returns `LicensesAccepted.unknown`, which is the line you are staring at.

cmdline-tools 22.0 already prints the deprecation banner, but it still does the license work after it, so the regexes still find their line. With my scratch SDK, where only `android-sdk-license` was present, 22.0 printed:

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

cmdline-tools 23.0 drops that part entirely. I ran `sdkmanager --licenses` from 23.0 twice, once with the `licenses/` folder present and once with it renamed away. The output was identical both times: the banner, the "no longer needed" warning, exit code 0. The tool no longer reports license state in any form, so there is nothing for Flutter to parse. The author of the fix PR reached the same conclusion and also found no license-status subcommand in the new `android` CLI.

The second half of the loop comes from the same place. `flutter doctor --android-licenses` is just a wrapper that runs `sdkmanager --licenses` interactively and pipes your keystrokes through. When 23.0 prints the warning and exits, there is nothing to accept, and Flutter has nothing new to read on the next `flutter doctor` run.

## Reproducing it: the version matrix

To make sure this was the whole story, I built a scratch SDK root with both `cmdline-tools/22.0` and `cmdline-tools/23.0`, pointed `ANDROID_HOME` at it, and ran `flutter doctor -v` with each combination. Flutter looks for `cmdline-tools/latest/bin/sdkmanager` first and then falls back to the highest-numbered versioned folder, so hiding the `23.0` folder is enough to switch.

| Flutter | cmdline-tools | `licenses/` on disk | `flutter doctor` says |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | only `android-sdk-license` | Some Android licenses not accepted |
| 3.44.8 | 22.0 | missing | Android licenses not accepted |
| 3.44.8 | 23.0 | only `android-sdk-license` | Android license status unknown |
| 3.44.8 | 23.0 | missing | Android license status unknown |
| 3.47.3 | 23.0 | only `android-sdk-license` | All Android licenses accepted |
| 3.47.3 | 23.0 | missing | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` present but empty | Android licenses not accepted |

On an unfixed Flutter, 23.0 turns every state into "unknown". On 3.47.3 the answer depends on the files again.

## Fix 1: upgrade Flutter to 3.47.3 or later

The fix is [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), merged to master on 2026-08-29 and cherry-picked to stable ([#192133](https://github.com/flutter/flutter/pull/192133)) and beta ([#192132](https://github.com/flutter/flutter/pull/192132)) on 2026-09-02. The first releases that contain it are stable 3.47.3 and beta 3.48.0-0.4.pre. The 3.47.3 hotfix entry in `CHANGELOG.md` lists #191487 by name.

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

What the patch does is narrow. It adds one more regex, `--licenses option is no longer needed`. When that line shows up and none of the old patterns matched, Flutter stops trusting stdout and lists `<sdk>/licenses/`. Any non-hidden, non-empty file there means `all`. No usable file means `none`. If the directory cannot be listed, the result is `unknown`. Older `sdkmanager` versions still go through the original parsing, untouched.

If you are pinned to an older Flutter line (3.44.x, 3.41.x), there is no backport. The cherry-picks only went to the 3.47 and 3.48 candidate branches, so on those lines use Fix 3 or live with the cosmetic warning.

## Fix 2: confirm the licenses are actually on disk

Before assuming the doctor line is lying, check. License acceptance has always been recorded as hash files under the SDK root, and that is what Gradle reads when it decides whether it may auto-download a missing platform or build-tools package:

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

On a working machine you will see at least `android-sdk-license`, containing one or more 40-character hashes such as `24333f8a63b6825ea9c5514f83c2829b004d1fee`. If the file is there, `flutter build apk` works regardless of what an unfixed `flutter doctor` says. The issue reporter noticed the same thing: APK builds kept succeeding.

If the folder is missing, for example on a brand-new CI image, cmdline-tools 23.0 has changed how you get it. There is no prompt any more. Installing any package writes the license file for you. I tested it on two empty SDK roots with only cmdline-tools 23.0 copied in as `latest`:

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

Both commands exited 0 with stdin closed, downloaded `platform-tools_r37.0.1`, and left `licenses/android-sdk-license` with the `24333f8a...` hash behind. That is enough for Flutter 3.47.3 to report "All Android licenses accepted". Note the package names: the new `android sdk install` uses slashes (`platforms/android-36`, `build-tools/36.0.0`), not the semicolons `sdkmanager` used.

## Fix 3: pin cmdline-tools 22.0 on older Flutter

If you are stuck on a Flutter release without the fix and want the doctor line clean, give Flutter an `sdkmanager` that still prints license counts. Flutter picks `cmdline-tools/latest` first, so installing 22.0 next to a 23.0 `latest` changes nothing. You have to take 23.0 out of the way.

In Android Studio, open **Settings > Languages & Frameworks > Android SDK > SDK Tools**, tick **Show Package Details**, untick **Android SDK Command-line Tools (latest)**, tick **22.0**, and apply. This is the workaround the reporter of #191558 confirmed.

From a terminal:

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

The install lands in `cmdline-tools/22.0`, and with `latest` gone Flutter falls back to that versioned folder. `flutter doctor --android-licenses` then shows the real interactive prompt again, and you can accept the missing ones. In a non-interactive shell, `yes | flutter doctor --android-licenses` still works on 22.0.

Two warnings about this route. First, it is a pin, and the next "update all" in Android Studio will put 23.0 back as `latest`. Second, some tooling hardcodes `cmdline-tools/latest/bin` (Gradle's SDK auto-download, a lot of CI scripts). Once the licenses are accepted, it is cleaner to upgrade Flutter and let 23.0 come back than to keep 22.0 around forever.

## Gotchas and lookalikes

**"All Android licenses accepted" on 3.47.3 is more generous than before.** The on-disk fallback cannot tell `some` from `all`. With only `android-sdk-license` present, 22.0 said "6 of 7 SDK package licenses not accepted" and old Flutter said "Some Android licenses not accepted". 3.47.3 on 23.0 says "All Android licenses accepted". For ordinary builds that is correct, since `android-sdk-license` covers platforms, build-tools, platform-tools, and the NDK. Preview, TV, and XR system images have their own license files (those are the other six in the 22.0 count), so if you install one of those, check `licenses/` for its file rather than trusting the doctor line.

**An empty license file counts as not accepted.** Some CI recipes `touch` the file to fake acceptance. On 3.47.3 a zero-byte `android-sdk-license` gives "Android licenses not accepted". Write the real hash, or better, let `android sdk install` create it.

**CI scripts that grep doctor output.** A step like `flutter doctor -v | grep "All Android licenses accepted"` fails on every unfixed Flutter with 23.0. `yes | flutter doctor --android-licenses` no longer fails, but it no longer does anything either. Check for the file instead: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`. If you test several Flutter versions in one pipeline, as in [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), expect the older matrix legs to print "unknown" while 3.47.3 and later pass.

**The `android` binary installs itself on first use.** The first time I ran `cmdline-tools/23.0/bin/android`, it printed "Downloading Android CLI...", unpacked into `~/.android/cli`, and showed the SDK terms of service and a usage-metrics notice. Add `--no-metrics` in CI. `android --version` reported `1.0.16261425` with cmdline-tools 23.0. The binary also exists in 22.0.

**"Unable to locate Android SDK" is a different problem.** While building the scratch SDK, my first doctor run failed before it even reached the license check, because the root had cmdline-tools but no `platforms` or `build-tools`. If you see that line, or "cmdline-tools component is missing", the fix is in [the cmdline-tools component is missing post](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), not here.

**`flutter config --android-sdk` beats `ANDROID_HOME`.** If you set a path with `flutter config` at some point, Flutter ignores `ANDROID_HOME` and may be checking a different SDK from the one you are inspecting. `flutter config --list` shows the stored path, and `flutter doctor -v` prints the path it actually used on the "Android SDK at" line.

**The new CLI is not wired into Flutter yet.** An open PR, [#191826](https://github.com/flutter/flutter/pull/191826), moves Flutter's NDK provisioning to `android sdk install` as well. As of 2026-09-15 it is not merged, so Flutter 3.47.3 still invokes the deprecated `sdkmanager` for licenses and relies on it keeping the old flags alive.

## Related

- [Fix: flutter doctor reports cmdline-tools component is missing](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) covers the Flutter SDK lookup order and the `sdkmanager` Java requirements that apply here too.
- If Gradle rather than doctor is complaining about your JDK, see [Toolchain installation does not provide the required capabilities](/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/).
- A corrupt SDK download shows up differently: [NDK (Side by side): Not in GZIP format](/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Another case where a hotfix release is the real fix: [Could not create Dart VM instance after flutter upgrade](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Sources

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487), the P1 tracking issue, with duplicates [#191558](https://github.com/flutter/flutter/issues/191558) and [#191963](https://github.com/flutter/flutter/issues/191963).
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), the fix, with stable and beta cherry-picks [#192133](https://github.com/flutter/flutter/pull/192133) and [#192132](https://github.com/flutter/flutter/pull/192132).
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826), the open PR for full Android CLI support.
- [Flutter CHANGELOG at 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) and [`android_workflow.dart` at 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart).
- [Android CLI documentation](https://developer.android.com/tools/agents/android-cli) for the `android sdk install`, `list`, `update`, and `remove` syntax.
- [sdkmanager documentation](https://developer.android.com/tools/sdkmanager).
