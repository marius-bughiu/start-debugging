---
title: "Fix: Google Play rejects a Flutter or .NET MAUI app for missing 16 KB memory page size support"
description: "Play rejects the bundle because a 64-bit .so still has 4 KB ELF segments. Find the offending library, rebuild it with NDK r28+, and verify with zipalign -P 16."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
---

The rejection is almost never about your code. Google Play scans the 64-bit native libraries in your app bundle and blocks the release if any of them has ELF `LOAD` segments aligned to 4 KB (`0x1000`) instead of 16 KB (`0x4000`). Both the Flutter engine and the .NET Android runtime have shipped 16 KB-aligned binaries for a while now, so the offender is nearly always a third-party plugin or binding library that was compiled with an old NDK. Find it, update or rebuild it, then confirm with `zipalign -c -P 16 -v 4`.

## The error in context

Uploading the bundle to the Play Console produces a release-blocking message along these lines:

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

The current wording in Google's own documentation is unambiguous about the scope and the date:

> all apps targeting Android 15 (API level 35) and higher must support 16 KB memory page sizes on 64-bit devices on Google Play. Starting February 1, 2027, if your app updates don't support 16 KB memory page sizes, you won't be able to release these updates.

Worth knowing the history, because a lot of the advice still floating around quotes stale dates: the requirement originally landed on November 1, 2025 for new apps and updates targeting Android 15+, developers could request an extension through May 31, 2026, and the hard block on non-compliant updates now sits at February 1, 2027 per [Android's page size guide](https://developer.android.com/guide/practices/page-sizes).

## Why does a 4 KB-aligned library break a 16 KB device?

Android has historically assumed a 4 KB memory page. Devices shipping with Android 15 and higher may use a 16 KB page instead, which cuts page-table pressure and measurably improves app startup. The dynamic linker maps each `PT_LOAD` segment of a shared library at a page-aligned address. If the segment's `p_align` is 4096 but the kernel's page size is 16384, the loader cannot honour the segment boundaries, and `dlopen` fails. The user sees an install failure, or a launch that dies immediately in `System.loadLibrary`.

There are actually two separate alignment requirements, and conflating them is the single biggest source of confusion:

- **ELF segment alignment.** Every `PT_LOAD` segment inside each `.so` must have `p_align` of at least 16384. This is a property of how the library was compiled and linked.
- **Zip entry alignment.** When native libraries are stored uncompressed in the APK (`extractNativeLibs="false"`, which is the default for modern builds), the linker maps them directly out of the APK. The zip entries themselves must therefore start on a 16 KB boundary. This is a property of how the package was assembled.

A library can pass one check and fail the other. Play checks both, and only for 64-bit ABIs.

## Which Flutter and .NET MAUI versions are already compliant?

Both toolchains have been fine for some time, which is why the offending file is usually a dependency.

**Flutter.** Checking the Flutter 3.44.2 stable SDK on disk (framework revision `c9a6c48`, engine `77e2e94`), `packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt` pins the NDK that `flutter.ndkVersion` resolves to:

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

That is NDK r28, which emits 16 KB-aligned segments by default. The same SDK's `DependencyVersionChecker.kt` hard-fails builds below AGP 8.6.0 and warns below AGP 8.11.1, while `gradle_utils.dart` stamps new projects with AGP 9.0.1 and Gradle 9.1.0. All of those sit comfortably above the AGP 8.5.1 that Google names as the minimum for correct uncompressed-library alignment. A Flutter 3.44 app is compliant by construction unless a plugin drags in a stale `.so`.

**.NET MAUI.** The .NET Android SDK sets the package alignment explicitly. From `Microsoft.Android.Sdk.DefaultProperties.targets` in `Microsoft.Android.Sdk.Windows` 36.1.53, the version bundled with the .NET 10 workload:

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

The surrounding comment states that only `4` and `16` are supported values. So the zip-alignment half of the requirement is handled by default, and you should never need to set that property yourself. If you inherited a project that pins `<AndroidZipAlignment>4</AndroidZipAlignment>`, delete the line.

For the ELF half, I ran an alignment check over the native libraries in the .NET 10 Android runtime packs on this machine (`Microsoft.Android.Runtime.*.36.1.53` and `Microsoft.NETCore.App.Runtime.Mono.android-arm64`). Every 64-bit runtime library reports `p_align` of `0x4000`: `libmonosgen-2.0.so`, `libmono-android.release.so`, `libnet-android.release.so`, `libSystem.Native.so`, `libSystem.Security.Cryptography.Native.Android.so`, `libxamarin-native-tracing.so`, and the Mono component libraries. Both the Mono and CoreCLR flavours are clean.

## How do I check an APK or AAB for 16 KB alignment?

Google's `check_elf_alignment.sh` is a bash script, which is awkward if you build on Windows. The zip-level check ships with the Android build tools and works everywhere:

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

For an app bundle, `bundletool` reports the configured alignment:

```bash
bundletool dump config --bundle=app-release.aab
```

Neither of those inspects ELF headers, though. To check the segments themselves, the NDK ships `llvm-objdump`:

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

A compliant library prints `align 2**14`. Anything at `2**12` or `2**13` fails.

If you would rather not depend on the NDK being installed, the program headers are trivial to parse directly. This is the script I used to audit the .NET runtime packs above, and it runs anywhere Python does:

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

Unzip the AAB or APK and point it at the 64-bit ABI directory:

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

The libraries printed as `UNALIGNED` are exactly the ones Play will list.

## How do I fix an unaligned Flutter app?

Start by identifying which plugin owns the file. Search your pub cache and the built APK, then map the `.so` back to a package:

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

Once you know the culprit, work through these in order:

1. **Update the plugin.** By far the most common fix. Most maintained packages rebuilt their binaries during 2025. Run `flutter pub outdated`, bump the offending dependency, rebuild, re-check.
2. **Update the Flutter SDK and the Android toolchain.** Confirm you are on Flutter 3.32 or newer, AGP 8.5.1 or newer in `settings.gradle.kts`, and that `android { ndkVersion = flutter.ndkVersion }` rather than a hardcoded old NDK string. A stale explicit `ndkVersion = "25.1.8937393"` in `android/app/build.gradle.kts` silently defeats everything else.
3. **Rebuild the native code yourself** if the plugin builds from source and is stuck on NDK r27 or older. Add the linker flags in its `CMakeLists.txt`:

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **Drop the dependency** if it is abandoned. An unmaintained package with a prebuilt 4 KB `.so` and no source is a hard blocker, and no build flag on your side can fix it. Fork it or replace it.

## How do I fix an unaligned .NET MAUI app?

The .NET 10 runtime is already compliant, so look at your NuGet packages, and specifically at Android binding libraries that embed a prebuilt `.aar` or `.so`. Ad SDKs, analytics SDKs, payment SDKs, and ML runtimes are the usual suspects.

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

Then unzip the resulting `.aab` from `bin/Release/net10.0-android/publish/` and run the checker against `base/lib/arm64-v8a/`. When a binding library is the offender, the fix is to update the NuGet package to a version whose upstream `.aar` was rebuilt with NDK r28. If none exists, you are repackaging the `.aar` yourself with a rebuilt native library, or dropping the dependency.

Two project-level things worth confirming while you are in there. Make sure you have not disabled uncompressed native libraries, since the whole zip-alignment mechanism depends on it, and make sure you are not still targeting an older SDK in a way that masks the problem locally but not in Play. Neither is a common misconfiguration, but both produce confusing results when present.

## What about libc.so and the 32-bit libraries my checker flags?

Two false positives that will send you down a rabbit hole if you audit the wrong directory. Both showed up immediately when I scanned the .NET 10 runtime packs.

**Stub libraries are not shipped.** The Android runtime packs contain `libc.so`, `libdl.so`, `liblog.so`, `libm.so`, and `libz.so` at `p_align = 0x1000`. These are link-time DSO stubs; the real implementations come from the device. They never enter your APK, so their alignment is irrelevant. This is the reason you must audit the built package rather than an `obj/` folder or a NuGet cache.

**32-bit libraries are exempt.** Every library in the `android-arm` (armeabi-v7a) runtime pack reports `0x1000`, and that is correct and permanent: a 32-bit process has no 16 KB page mode to support. Play only checks 64-bit ABIs, and so does the .NET Android SDK's own build-time check, whose diagnostic string reads `Not a 64-bit ELF image.  Ignored.` Filter your scan to `arm64-v8a` and `x86_64`, exactly as the script above does.

If you want to prove the fix end to end rather than trusting the scan, create an AVD from the "Google APIs Experimental 16 KB Page Size" system image in the SDK Manager, then confirm the emulator is really running 16 KB pages before you install:

```bash
adb shell getconf PAGE_SIZE
```

That must print `16384`. An app that installs and launches there will pass the Play check.

## Related

If the build never gets far enough to produce a bundle, the underlying failure is usually elsewhere in the Gradle chain: [Gradle task assembleDebug failing with exit code 1](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) and [Gradle build failed to produce an .apk file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) both cover reading the real error out of a wrapped log. A missing NDK or SDK component shows up as [flutter doctor reporting cmdline-tools component is missing](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), and dependency-level native conflicts often surface first as an [AndroidX conflict during a Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/). Teams still on the old stack will hit all of this at once during the [move from Xamarin.Forms to MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Sources

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers), for the requirement, the February 1, 2027 date, the `zipalign` and `llvm-objdump` checks, and the linker flags for NDK r27 and older.
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog), for the original November 1, 2025 announcement.
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog), for the .NET-side guidance and the reported startup and power improvements.
- Version and alignment facts measured locally against Flutter 3.44.2 stable and the .NET 10 Android workload (`Microsoft.Android.Sdk.Windows` and `Microsoft.Android.Runtime.*` 36.1.53).
