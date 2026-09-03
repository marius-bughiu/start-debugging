---
title: "Migrate a .NET MAUI Android app from Mono to CoreCLR in .NET 11"
description: "A step-by-step migration off Mono onto CoreCLR for .NET MAUI on Android: the API 24 floor, the Mono-only MSBuild properties that now break your build, why your APK grew, how to profile the startup regression with dotnet-dsrouter and dotnet-trace, and what a rollback actually looks like now that the Mono path is gone."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
---

For a small app this migration is a `TargetFramework` bump, an `android:minSdkVersion` bump, and an afternoon of measuring. For a large one, budget a week, and expect the whole week to go into two things: deleting Mono-era MSBuild properties that now either do nothing or actively break the build, and chasing a startup regression that has nothing to do with your code. The payoff is real (unified diagnostics, tiered JIT, dynamic PGO, a plausible path to Native AOT on Android), but the honest framing is that this is not optional. As of [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), Microsoft no longer surfaces a separate Mono path for Android, iOS, or Mac Catalyst. This guide targets .NET 11 Preview 7 (`11.0.100-preview.7`, released 2026-08-11) with .NET MAUI `11.0.0-preview.7`, migrating from .NET 10 with Mono. .NET 11 GA is scheduled for 2026-11-10.

## Why this is worth doing beyond "you have no choice"

- **Your profiler finally works.** `dotnet-trace` and `dotnet-counters` now attach to a running Android app the same way they attach to an ASP.NET Core process, through `dotnet-dsrouter`. No more Mono-specific tracing dialect.
- **Tiered compilation and dynamic PGO arrive on the phone.** Mono AOT compiled once at build time and that was the end of the optimization story. CoreCLR instruments at Tier 0 and recompiles hot methods at Tier 1 with real profile data, so steady-state throughput on a long-lived app improves without you changing anything.
- **ReadyToRun replaces Mono AOT as the startup mechanism.** On Android, MAUI defaults to *composite partial* R2R for CoreCLR release builds, driven by `.mibc` profiles that ship in the workload. Only the methods the profile says matter get precompiled, which is what keeps the size overhead from being catastrophic.
- **One runtime, one bug tracker.** A `System.Text.Json` or `HttpClient` bug on Android is now the same bug it is on the server, fixed in the same place.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Minimum Android API | Raised from 21 (Android 5.0) to 24 (Android 7.0) | high |
| Android ABIs | Android x86 (32-bit) is not supported under CoreCLR | high |
| Mono AOT properties | `RunAOTCompilation`, `AndroidAotMode`, `UseInterpreter` are Mono-only; `RunAOTCompilation=true` can still invoke `MonoAOTCompiler` and fail the build | high |
| Startup time | Large apps have reported multi-second regressions and ANRs | high (situational) |
| APK size | R2R images live inside your `.dll` files, so assemblies grow | medium |
| NuGet packages | `NU1703` when a package resolves `MonoAndroid` assets instead of `net6.0-android` or later | medium |
| Legacy resources | `XA0149` for legacy Xamarin.Android resources embedded in a dependency | low |
| `Microsoft.Maui.Controls.Compatibility` | Package removed in Preview 6 | medium (only if referenced explicitly) |
| HTTP errors | `AndroidMessageHandler` transport failures throw `HttpRequestException` instead of `WebException` | low |
| Runtime embedding | The Android embedding APIs are not carried forward to CoreCLR | high (if you use them) |

The API level floor is the one that reaches your users. Per the [breaking change notice](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), apps built with .NET 11 cannot be installed or run on API 21, 22, or 23. Check your Play Console distribution numbers before you start, because this is a decision about users, not a build setting.

## Pre-flight checklist

- .NET 11 SDK `11.0.100-preview.7` or later, with the `maui-android` workload installed.
- `$ANDROID_HOME` set to a valid Android SDK path. `dotnet-dsrouter` uses `adb` from there to set up port forwarding, and it will not find it reliably otherwise.
- The diagnostics tools installed globally: `dotnet tool install --global dotnet-dsrouter`, `dotnet-trace`, `dotnet-counters`.
- A **numeric baseline captured on .NET 10 with Mono, before you change anything.** This is the step everyone skips and then regrets, because "it feels slower" is not something you can bisect.
- A real device, not just the emulator. The regressions people have reported are startup regressions, and emulator startup timing is not representative.

## Migration steps

1. **Capture the Mono baseline.** On your current .NET 10 release build, install the APK and measure cold start with the Android activity manager, which reports `TotalTime` in milliseconds:

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Run it five times, discard the first, and record the median. Record the release APK or AAB size too. **Verify:** you have two numbers written down somewhere that is not your terminal scrollback.

2. **Move the target framework and the API floor together.** Both changes, in one commit, because CoreCLR on Android requires API 24:

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   If you set `android:minSdkVersion` by hand in `Platforms/Android/AndroidManifest.xml`, raise it to `24` so the manifest and the project agree. **Verify:** `dotnet build -f net11.0-android -c Release` succeeds and the generated manifest shows `minSdkVersion="24"`.

3. **Delete or guard every Mono-only MSBuild property.** Grep your `.csproj`, `Directory.Build.props`, and any CI-injected properties for `RunAOTCompilation`, `AndroidAotMode`, `AndroidEnableProfiledAot`, `UseInterpreter`, and `UseMonoRuntime`. `RunAOTCompilation=true` left in a `Directory.Build.props` is a known build break: the `MonoAOTCompiler` target still runs even though the app is on CoreCLR ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068)). Delete them outright, or if you still cross-build an older TFM, guard them:

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **Verify:** `dotnet build -f net11.0-android -c Release -bl` and then search the binary log for `MonoAOTCompiler`. Zero hits is the pass condition.

4. **Clear the ABI list and the package warnings.** Drop `x86` from `RuntimeIdentifiers` if it is still there, since CoreCLR does not ship it:

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   Then deal with `NU1703`. Introduced in Preview 5, it fires when a package resolves assets from the deprecated `MonoAndroid` folder: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." Upgrade the package if a modern version exists. If it does not, you have found a Xamarin-era dependency that is now on borrowed time, and suppressing the warning is a decision to carry that risk, not a fix. **Verify:** `dotnet restore` is clean, or every remaining `NU1703` is a package you have consciously triaged.

5. **Rebuild in Release and re-measure against step 1.** Same device, same procedure, same number of runs:

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Microsoft's own position is that Android lands "within 10 percent of Mono on startup and app size" for a baseline template app. **Verify:** if you are inside that band, you are done with the performance work. If you are 2x or worse, go to step 6 rather than start randomly toggling MSBuild properties.

6. **Profile the regression instead of guessing.** Add an `app.env` file next to the `.csproj` containing `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend`, and reference it conditionally:

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   Start the router, build with the profiler enabled, launch the app, then attach:

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   Because the port was configured with `suspend`, the runtime blocks at startup until `dotnet-trace` connects, which is exactly what you need to see the startup path rather than everything after it. On Windows, use `mylocalport` instead of `~/mylocalport`, since the IPC channel is a named pipe. **Verify:** you have a `.nettrace` file with a populated startup window, and you can name the top three methods by inclusive time.

7. **Tune only what the trace justifies.** If assembly size is the problem, R2R is the first knob, because R2R images are packed inside the `.dll` files and that is why your assemblies grew:

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   These pull in opposite directions: turning R2R off trades startup for size, and `TrimMode=full` buys size back but now trims your own code and your NuGet references, so it needs a full regression pass. Change one at a time and re-run step 5 between each. **Verify:** each knob is justified by a measured delta you can quote, not by a blog post.

8. **Roll out in stages.** Ship to an internal track first and watch ANR rate specifically, not just crash rate. The reported CoreCLR failure mode on large apps is a startup that runs long enough for Android to kill the process, which shows up as ANRs rather than exceptions. **Verify:** ANR rate in Play Console after a week of internal testing is flat against your Mono build.

## Verification checklist

- `dotnet build -f net11.0-android -c Release` produces no `MonoAOTCompiler` invocation in the binary log.
- Cold start median on a real device is within your accepted band of the .NET 10 baseline.
- APK/AAB size delta is recorded and accepted.
- The full test suite passes, including any tests that touch reflection, `HttpClient` error paths, or serialization.
- Hot Reload works. On CoreCLR this goes through Edit and Continue rather than the Mono interpreter, so it is a genuinely different code path from what you tested last release.
- No API 21-23 devices in your active install base, or you have communicated the drop.

## Rollback plan

Say this part out loud: **there is no runtime-level rollback anymore.** `<UseMonoRuntime>true</UseMonoRuntime>` was documented as the escape hatch when CoreCLR became the default in Preview 4, and it was framed then as a temporary unblock while you filed a regression. Preview 6 removed the separate Mono path for Android, iOS, and Mac Catalyst. Treat the property as gone and do not build a release plan around it.

Your actual rollback is the target framework: keep the `net10.0-android` build green on a branch until the .NET 11 build has survived a real production rollout. That is a heavier rollback than flipping one property, which is precisely why steps 1 and 5 exist.

## Gotchas that cost real time

**The startup regression is real and it is not evenly distributed.** Two issues document the failure mode: [dotnet/android#10588](https://github.com/dotnet/android/issues/10588) reports "an app that takes 1s to launch on mono can take 6s on coreclr," with ANRs on Avalonia's `ControlCatalog.Android`, and [dotnet/android#10914](https://github.com/dotnet/android/issues/10914) reports roughly 1.0s to 6.0s cold start and a 21 MB to 38 MB APK growth on `11.0.100-preview.2`. Both are Avalonia rather than MAUI, and both predate the composite partial R2R and MIBC profile work that landed later in the preview cycle, so do not read them as your expected outcome. Read them as the reason step 1 is mandatory.

**XAML-heavy startup paths are the ones that hurt.** The common thread in the reports is reflection and XAML parsing during initialization, which is exactly the work partial R2R cannot precompile if the shipped `.mibc` profile does not cover your app's shape. If your app builds a large visual tree before the first frame, that is where to look first.

**`UseInterpreter` silently stops mattering.** It was `true` by default in Debug on Mono, and it is what made Mono-era Hot Reload work. On CoreCLR it is inert. If you had it set for a reason (a dynamic code path that Mono AOT could not handle), that reason has not disappeared, it has just moved: CoreCLR on Android runs a real JIT in Debug, so the code will work, but re-test it deliberately rather than assuming.

**Your APK contents change shape.** Under Mono you shipped `libmonosgen-2.0.so` plus `libaot-*.dll.so` images. Under CoreCLR you ship `libcoreclr.so`, `libclrjit.so`, `libmonodroid.so` (the Android glue keeps its Mono-era name), and a single `libassemblies.arm64-v8a.so` holding compressed MSIL with R2R images. If you have build scripts, size budgets, or ProGuard/R8 configuration that name those files, they need updating.

**Trimming is where the size actually is.** MAUI still defaults to `TrimMode=partial`, which trims framework assemblies but leaves your code and your NuGet references alone. Most of the size complaints resolve into trimming complaints once you look at the per-assembly breakdown.

## Related

- The runtime switch itself was announced when [MAUI made CoreCLR the default on Android, iOS, and Mac Catalyst in Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), which is where the opt-out property came from.
- The escape hatch closed two months later when [MAUI mobile became CoreCLR-only in Preview 6](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/).
- If you are still on the old stack, the prerequisite migration is [Xamarin.Forms to MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/), not this one.
- The R2R-versus-Mono-AOT tradeoff in step 7 is covered in depth in [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), and the endgame CoreCLR unlocks on Android is described in [what Native AOT actually costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/).
- If `TrimMode=full` in step 7 breaks your serialization, the failure looks like [reflection-based serialization has been disabled for this application](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/).
- Changing the shipped ABI list in step 4 can produce [the "doesn't support required ABI" install failure](/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) on devices you were previously serving.

## Sources

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), the .NET Blog
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), the .NET Blog
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation), Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework), Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter), Microsoft Learn
- [dotnet/maui#33386, the CoreCLR on Android tracking epic](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588, ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068, RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
