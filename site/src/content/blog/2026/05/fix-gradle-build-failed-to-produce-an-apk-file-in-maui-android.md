---
title: "Fix: Gradle build failed to produce an .apk file in MAUI Android"
description: "Nine out of ten times the real Gradle error is buried higher in the MSBuild log. JDK 17 path, missing maui-android workload, and Windows long paths are the usual root causes."
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
---

The fix: this MSBuild error is almost never the actual error. Scroll the build log up past it until you hit the first `error` line from `gradlew.bat` or `aapt2`. Nine times out of ten the real cause is one of three things: `JAVA_HOME` points at JDK 11 (Android Gradle Plugin 8.x in MAUI 11 needs JDK 17), the `android` or `maui-android` workload was not restored after a .NET SDK bump, or a Windows long-path violation truncated the obfuscated R8 output. Fix the underlying error and the `.apk` is produced on the next build.

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

This guide is written against .NET 11 GA, the `net11.0-android` target framework, .NET MAUI 11.0.0, and the Android Gradle Plugin (AGP) bundled with `Xamarin.Android.Sdk` 35.x (the version Microsoft pins for `dotnet workload install android` on .NET 11). The `XA1029` code is raised by `Xamarin.Android.Build.Tasks` after `gradlew assembleDebug` or `assembleRelease` exits non-zero. The text "failed to produce an .apk file" is a wrapper, not the cause.

## Why MAUI Android wraps the real Gradle error

MAUI does not call Gradle directly during a normal `dotnet build`. The Android-specific MSBuild target (`_CompileToDalvikWithD8`, `_GenerateAndroidPackage`) writes a generated `build.gradle.kts` into `obj/Debug/net11.0-android/<rid>/android/`, then shells out to the bundled `gradlew.bat` (Windows) or `gradlew` (macOS, Linux). When `gradlew` exits non-zero, the MSBuild task swallows the multi-thousand-line Gradle log into a single diagnostic file at `obj/Debug/net11.0-android/<rid>/android/build.log` and emits `XA1029`. Visual Studio surfaces only the wrapper. The actual stack trace, missing dependency, JDK rejection, or signing failure is in `build.log` plus the lines immediately above `XA1029` in the MSBuild output panel.

Treat `XA1029` like an HTTP 500: it tells you the build broke, not what broke. The first move is always to find the actual `> Task :` line that failed.

## Reading the diagnostic log to find the real cause

From a terminal in your project directory, rerun the build with the verbosity that exposes every Gradle line:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

Then open `msbuild.binlog` in the [MSBuild Structured Log Viewer](https://msbuildlog.com/) and search for `FAILURE: Build failed`. The line above it names the failing Gradle task: `:app:processDebugResources`, `:app:mergeDebugResources`, `:app:lintVitalReportRelease`, or `:app:compileDebugJavaWithJavac` are the usual suspects. Each one points at a specific category of fix below.

If the binlog is empty for the Gradle phase, it means Gradle never started, which itself means `JAVA_HOME` resolution or workload restore failed before any task ran. Skip to the JDK and workload sections.

## Cause 1: JAVA_HOME points at the wrong JDK

This is the single most common cause after a .NET SDK bump. AGP 8.x, which ships with Xamarin.Android 35 (the .NET 11 default), refuses to start under JDK 11 with this error inside `build.log`:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

The matching MSBuild surface is `XA1029`. Microsoft documented the JDK floor for MAUI as Java 11 for the .NET 6 to .NET 8 era, then Java 17 from MAUI 9 onward, tracking the AGP requirement upstream. See the long-running MAUI issue [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) for the original break.

The fix is to point `JAVA_HOME` at a JDK 17 install. On a Visual Studio 2026 Windows box, the bundled OpenJDK 17 lives at `C:\Program Files\Microsoft\jdk-17.0.x-hotspot`. Set it permanently:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

Then either restart the shell or, in CI, also pass `-p:JavaSdkDirectory=...` on the `dotnet build` command line so MSBuild picks it up without relying on the inherited environment:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

You can verify which JDK MSBuild actually selected by grepping the binlog for `JdkDirectory`, or by running `dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk`.

## Cause 2: maui-android or android workload missing

The second most common cause: you upgraded the .NET SDK on the box (or installed it fresh on CI) and never restored the workloads. The MSBuild task fails at `_GenerateAndroidPackage` because the `Xamarin.Android.Sdk` pack that owns Gradle integration is not on disk. The wrapper is still `XA1029`; the actual error inside `build.log` is:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

Restore the workload pinned to the SDK band you have installed:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` walks every `*.csproj` in the current directory, reads its `TargetFrameworks`, and installs whatever pack each target framework needs. On CI that is the only command worth running because it is idempotent and version-locked. The standalone `dotnet workload install maui-android` is the right call on a fresh dev box. Microsoft documents the workload split in [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install).

If you installed MAUI through the Visual Studio 2026 installer and then also ran `dotnet workload install maui` from the CLI, you can land in a state where Visual Studio cannot locate either copy. The MAUI troubleshooting doc spells out the [full uninstall and reinstall sequence](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), which is more work than it sounds but is the only reliable recovery from a split workload state.

## Cause 3: Windows long-path violation in obj output

The third recurring cause is purely a Windows artifact. R8 and `aapt2` both write deeply nested obfuscated paths into `obj\Debug\net11.0-android\android\app\build\intermediates\`. For a project at `C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` the full path of an intermediate `.dex` file routinely exceeds the legacy 260-character `MAX_PATH` limit. The Gradle worker reports it as:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

Two fixes, in order of preference:

1. Move the repo to a shorter root: `C:\src\Mobile\` instead of `C:\Users\you\source\repos\MyCompany\Mobile\`.
2. Enable long-path support across the OS, the .NET SDK, and Git. As an Administrator PowerShell:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   Then add `<UseAppHost>false</UseAppHost>` is not the fix here; what you actually need is the manifest entry. Edit your `.csproj` to set `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+) and ensure your project's `app.manifest` declares `longPathAware`. The Android side of the build picks up the OS flag once you sign out and back in.

The first option is faster and works on every machine without admin. Take it unless your repo path is fixed by policy.

## Cause 4: lintVitalRelease fails on a Release build only

If `dotnet build -c Debug` succeeds and `dotnet publish -c Release -f net11.0-android` fails with `XA1029`, the Gradle task that died is `:app:lintVitalReportRelease`. AGP 8 promoted lint failures from warnings to build errors for Release configurations. You will see this in `build.log`:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

The right fix is to read the lint report at `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` and address the actual issues (missing translations, hardcoded strings in `<application>` labels, deprecated Android APIs targeting `compileSdkVersion 35`).

The wrong-but-tempting fix is to suppress lint:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

Use that only as a tactical unblock for a release that has to ship today. Lint findings about missing `android:exported` declarations are real bugs on Android 31+ and will eventually crash on launch.

## Cause 5: missing or wrong keystore for signed Release builds

A signed Release build adds `:app:signReleaseBundle` to the task list. If the keystore path resolves to nothing, AGP fails with:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

On a developer box this means your `<AndroidSigningKeyStore>` MSBuild property points at a file that does not exist for the current user. On CI it usually means the secret containing the base64-encoded keystore was not decoded into the path that `csproj` references. The minimal correct CI invocation:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

The four `AndroidSigning*` properties are mandatory together. Setting only three of them fails with the same `XA1029` and a different Gradle task line. Microsoft documents the property names in [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli).

## Cause 6: corrupt Gradle daemon or stale .gradle cache

After a long string of failed builds, the user-scoped Gradle cache at `~/.gradle/caches/` can land in a state where every subsequent build fails with a generic `XA1029` and a `build.log` complaining about lock files. Nuke the cache and the workload-scoped Gradle distribution:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

On Windows the equivalent is `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"`. The next build will redownload the AGP distribution (about 200 MB) and rehydrate the dependency graph; it takes 5 to 10 minutes the first time and is fast after that.

This is the right fix for "it worked yesterday and nothing changed." It is the wrong fix when you can name what changed (a workload bump, a JDK swap, a new NuGet package); chase the cause first.

## Gotchas and lookalike errors

- `XA0119: Could not find android.jar for API level 35` is a sibling error from the same stage. It is always a missing `android-sdk;platforms;android-35` install, not a Gradle problem. Run `androidsdkmanager --install platforms;android-35`.
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` is also `Xamarin.Android.Build.Tasks` but earlier in the pipeline. It usually means `obj/` is read-only because Defender quarantined a file. Check `Get-Acl obj` and the Defender quarantine log.
- `MSB6006: "java.exe" exited with code 1` from the linker phase is misleadingly named: it is `R8` minification failing on a class it cannot trace. Add a ProGuard rule and try again. See the breakdown in [a recent post on cold-start tuning](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) for the underlying mechanics; the same trim/AOT contracts apply on Android.
- "Build SUCCESS" with no `.apk` in `bin/` happens when `<AndroidPackageFormat>aab</AndroidPackageFormat>` is set in a parent `Directory.Build.props`. The build produces an `.aab` (App Bundle) instead, which is what the Play Store actually wants. The `XA1029` text says ".apk" only because it is the historical default; the underlying check is "did the package step write its expected output file."

## Related

- [How to package a MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) walks through the Windows side of the same publish pipeline.
- [.NET 11 preview 4: dotnet watch finally lands for MAUI Android and iOS](/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) covers the inner-loop tooling that runs on top of the same Gradle harness.
- [MAUI on .NET 11 preview 4 makes CoreCLR the default for Android and iOS](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) explains why the runtime swap shifted some lint rules from warnings to errors in Release builds.
- [How to migrate a high-performance Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) is the most common reason a project that built fine on Xamarin starts hitting `XA1029` after the MAUI port.

## Sources

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), Microsoft Learn, .NET MAUI 11.
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906), the canonical issue tracking the JDK requirement bump.
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164), community thread enumerating Release-only `XA1029` causes.
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli), the source of truth for `AndroidSigning*` MSBuild properties.
- [Java versions in Android builds](https://developer.android.com/build/jdks), Android team documentation for the JDK floor by AGP version.
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install), the workload install / restore semantics referenced above.
