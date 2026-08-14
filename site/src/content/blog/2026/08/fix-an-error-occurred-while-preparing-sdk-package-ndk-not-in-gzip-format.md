---
title: "Fix: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "The SDK Manager is re-unpacking a corrupt archive it cached in .downloadIntermediates. Delete that folder and the half-extracted ndk/<version> directory, then re-run the build."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
---

Delete the SDK Manager's download cache and the partially extracted NDK directory, then build again. The archive it is unpacking is corrupt, and because it caches that archive it will fail identically on every retry until you remove it. On Windows that is `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` plus `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358`. If it fails a second time after a clean cache, you are behind a proxy or an antivirus TLS interceptor that is rewriting a 750 MB download, and the answer is to install the NDK by hand from `dl.google.com`.

## The error, in full

The message shows up mid-build, usually during the Gradle configuration phase, and it is a warning line rather than the top-level failure:

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

Underneath it is a `java.util.zip.ZipException: Not in GZIP format` thrown out of `GZIPInputStream`, and the version number varies with whatever your project pins. The two things that identify this specific failure are the package name `NDK (Side by side)` and the fact that it reproduces byte for byte on every retry, including after a reboot, a `flutter clean`, and an Android Studio restart. A genuinely flaky network produces a different error each time. This one does not.

## What makes a Flutter build download the NDK at all?

This is the part that catches people out: a Flutter app with no native code, no C++, and no `externalNativeBuild` block still downloads a 750 MB NDK on first build. That is deliberate, and it is Flutter's doing rather than the Android Gradle Plugin's.

AGP needs the NDK to strip debug symbols from native libraries, but it only downloads the NDK when it thinks it is compiling native code. Flutter always ships native libraries (the engine and your AOT-compiled Dart), so it needs the stripping, so it tricks AGP into fetching the toolchain. Confirmed against a local Flutter 3.44.2 stable install, `FlutterPlugin.kt` calls this unconditionally at line 228:

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

The `CMakeLists.txt` it points at is an empty file whose only purpose is to make AGP believe there is native code to build. So the NDK download is not optional, it is not skippable, and every fresh machine or fresh CI runner hits it. A three-quarter-gigabyte download that runs once per environment is exactly the profile that produces truncated archives.

The version being fetched comes from Flutter, not from you. Same install, `packages/flutter_tools/lib/src/android/gradle_utils.dart` line 68:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

That is NDK r28c. I checked the installed copy on this machine and `ndk/28.2.13676358/source.properties` reads `Pkg.ReleaseName = r28c`, so the revision-to-release mapping is not a guess.

## Why does the archive fail the GZIP check?

Ranked by how often each one is the real cause.

**A corrupt archive cached in `.downloadIntermediates`.** The SDK Manager stages a package download in `<sdk>/.downloadIntermediates` before unpacking it. If the connection dropped, the disk filled, or the process was killed partway through, a truncated file stays in that directory. The downloader treats the cached file as a resumable download and hands it straight to the unpacker on the next attempt, so retrying reproduces the same exception forever. This is the case in the large majority of reports, and it is why "I already tried again five times" is not evidence against it.

**A proxy or TLS-inspecting antivirus rewriting the response.** `GZIPInputStream` throws this exact string when the first two bytes are not the gzip magic number `1f 8b`. A corporate proxy that answers with an HTML block page, a captive portal that intercepts the request, or a scanner that sets `Content-Encoding: gzip` on a body it did not actually compress all produce a stream that fails the magic-number check on byte one. The tell is that a clean cache does not help: you get a fresh, equally invalid download.

**A full disk.** A 750 MB download plus a 4 GB extraction needs headroom the SDK Manager does not check for in advance. It writes what it can and the truncated result fails the same way.

## How do I clear the download cache and the half-extracted NDK?

Close Android Studio first, since it holds handles on these directories on Windows. The SDK root is `%LOCALAPPDATA%\Android\Sdk` on Windows, `~/Library/Android/sdk` on macOS, and `~/Android/Sdk` on Linux.

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

Both the dotted and undotted spellings appear across Android Studio versions, so remove whichever exist and ignore the misses. On the install I inspected for this article the SDK ships `.temp` with a leading dot.

Deleting the `ndk/<version>` directory matters as much as clearing the cache, and it is the step most write-ups skip. Read on for why.

## What if the next build fails with CXX1101 instead?

That happens because the failed unpack left a partial directory behind, and now a different code path finds it.

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

AGP resolves an installed NDK by reading `source.properties` inside `ndk/<revision>/`. The SDK Manager writes that file last, after the archive is fully extracted, precisely so a half-finished install is not mistaken for a good one. When the unpack dies on the gzip error you are left with a directory full of toolchain files and no `source.properties`, which is neither absent nor valid.

From that point the SDK Manager sees a directory at the expected path and does not re-download, while AGP sees no `source.properties` and refuses to use it. The build is stuck between two components that disagree about whether the package exists, and the error message changes to something that looks unrelated. That is why plenty of threads on this end with people setting `ndk.dir` in `local.properties` or pinning an older NDK version: they are working around the second error without ever clearing the first one. Delete the directory and both go away together.

For reference, a correctly installed copy contains both files:

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## How do I install the NDK from the command line?

Taking Gradle and Android Studio out of the loop makes the failure much easier to read, and `sdkmanager` prints the underlying stack trace instead of a one-line warning. The binary lives in `<sdk>/cmdline-tools/latest/bin`. If it is not there, [installing the Android SDK Command-line Tools](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) is the prerequisite.

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

If you are behind a proxy, pass it explicitly rather than relying on Studio's settings, which `sdkmanager` does not read:

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

Do not reach for `--no_https` as a fix. It downgrades the transfer to plain HTTP, which makes an intercepting proxy more likely to mangle the body, not less. It exists for environments that block CONNECT entirely.

## How do I install the NDK by hand when the downloader keeps failing?

This is the reliable escape hatch on a locked-down network, because it moves the download to a tool you control and lets you verify the bytes.

1. Download the standalone archive from `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip`, substituting `windows` for Windows. macOS ships a `.dmg` rather than a zip at this URL, so mount it and copy the payload out.

2. Verify the SHA-1 against the value published on the NDK downloads page before you trust it. For r28c the Linux zip is 722,261,334 bytes with SHA-1 `a7b54a5de87fecd125a17d54f73c446199e72a64`, and the Windows zip is 748,118,221 bytes with SHA-1 `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d`. If the hash is wrong, your proxy is confirmed as the culprit and no amount of cache clearing will help.

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. Rename the extracted `android-ndk-r28c` directory to the revision number and move it into the SDK. The revision, not the release name, is what AGP looks for:

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. Build. AGP reads `source.properties` and accepts the toolchain. The one difference from a managed install is the missing `package.xml`, so `sdkmanager --list_installed` will not report the package. That is cosmetic for the build, but it matters if your CI gates on the package listing rather than on the directory.

## Which NDK version does my project actually need?

Whatever your project pins, and by default Flutter pins it for you. As of August 2026:

| Role | NDK release | Revision string |
| --- | --- | --- |
| Flutter 3.44 default | r28c | `28.2.13676358` |
| Latest stable | r29 | `29.0.14206865` |
| Latest LTS | r27d | `27.3.13750724` |

Do not "fix" this error by downgrading to an NDK that happens to be cached on your machine. NDK r28 is the first release that builds shared libraries aligned for 16 KB memory pages, which Google Play now requires, so dropping to r27 to dodge a download problem trades a build failure for [a store rejection](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

You do sometimes need to raise the version, when a plugin needs a newer toolchain than the Flutter default. Flutter detects that and tells you exactly what to write:

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

Changing that string starts a fresh download of a different package, so if you are still on a network that corrupts large transfers, hand-install the new revision before you change the pin. Otherwise you will watch the same error move to a new version number.

## Gotchas that produce the same message for a different reason

**Docker and CI images with a small layer budget.** A build container that runs out of writable space mid-extract fails identically to a truncated download. Check free space in the SDK volume before blaming the network. Pre-baking the NDK into the image is the durable fix, and it removes a 750 MB download from every job.

**Two builds racing on one SDK.** Parallel CI jobs sharing a mounted SDK directory will interleave writes into `.downloadIntermediates` and corrupt each other's archives. Give each job its own `ANDROID_SDK_ROOT`, or serialise the first-run install.

**`Failed to install the following Android SDK packages as some licences have not been accepted`.** Different error, same build phase. That one is fixed by `sdkmanager --licenses`, not by clearing caches.

**A generic `Gradle task assembleDebug failed with exit code 1`.** That line is a wrapper, and the gzip warning may be scrolled well above it. If you cannot see the real cause, [re-run the build verbosely first](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) rather than guessing.

**A `.gz` failure in a plugin's own download step.** Some plugins fetch their own prebuilt binaries at configuration time. If the failing package name is not `NDK (Side by side)`, this article is the wrong page.

## Related

If the build was already unhealthy before the NDK download entered the picture, [AndroidX conflicts during a Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/) and [minSdkVersion mismatches from plugins](/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) are the two that most often sit underneath a first-run failure on a new machine. For teams where every runner pays this download once, [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) covers caching the SDK properly so it happens once per image instead of once per job.

## Sources

- [NDK Downloads](https://developer.android.com/ndk/downloads), for the r29, r28c, and r27d revision strings, archive sizes, and SHA-1 checksums quoted above.
- [sdkmanager command-line reference](https://developer.android.com/studio/command-line/sdkmanager), for `--install`, `--sdk_root`, `--verbose`, and the `--proxy`, `--proxy_host`, `--proxy_port` trio.
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) and [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831), for the CXX1101 follow-on failure and the workarounds people reach for instead of clearing the cache.
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945), for how the Flutter default revision is chosen and when a plugin forces you above it.
- Source quoted from a local Flutter 3.44.2 stable install: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`, `FlutterPluginUtils.kt`, `FlutterExtension.kt`, `packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt`, and `packages/flutter_tools/lib/src/android/gradle_utils.dart`.
- SDK layout details verified against an Android SDK on this machine: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`), `ndk/28.2.13676358/package.xml`, and the dotted `.temp` cache directory.
