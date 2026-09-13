---
title: "How to enable R8 shrinking and obfuscation for a .NET MAUI Android release build"
description: "Set AndroidLinkTool to r8, keep trimming on, and add a ProguardConfiguration file. Why .NET 10 and .NET 11 RC 1 still ship un-obfuscated Java, how the new AndroidR8ObfuscationMode property changes that, and how to verify R8 actually ran."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
---

**Short answer:** add `<AndroidLinkTool>r8</AndroidLinkTool>` to a Release-only `PropertyGroup` in your MAUI `.csproj`, leave trimming on (it is on by default in Release), and put any keep rules in a `proguard.cfg` file with the `ProguardConfiguration` build action. That turns on R8 shrinking and optimization of the Java side of your app. It does **not** obfuscate anything on the SDKs shipping today: .NET for Android 36.1.69 (.NET 10) and 37.0.0-rc.1.2257 (.NET 11 RC 1) both inject `-dontobfuscate` into the R8 configuration. Real obfuscation arrives with the new `AndroidR8ObfuscationMode` property, which defaults to `private-members` in .NET 11 after RC 1 and is an opt-in backport for the next .NET 10 servicing release.

That last detail matters more than it used to. Google announced on August 26, 2026 that from February 2027, app bundles on Google Play need at least 25% optimization, shrinking, and obfuscation coverage of their DEX code (Android vitals only alerts once a bundle carries 10 MB of DEX for apps, 50 MB for games). A MAUI app pulls in a lot of AndroidX and Google Play services Java, so the DEX side is not small.

Everything below was traced through the `dotnet/android` source at the release tags named above, so you can check each claim against the MSBuild targets yourself.

## What R8 touches in a MAUI app, and what it does not

A MAUI Android package carries two kinds of code, and they are shrunk by different tools:

- **Managed code** (your C#, MAUI, the BCL) is trimmed by ILLink when `PublishTrimmed` is `true`. R8 never sees it. Obfuscating C# is a separate problem that R8 cannot solve.
- **Java bytecode** (AndroidX, Material, Google Play services, Firebase, any `.aar` you bind, plus the Java Callable Wrappers the build generates for every managed type that extends a Java type) is turned into `classes.dex`. By default the D8 compiler does that with no shrinking. With `AndroidLinkTool=r8`, R8 dexes and shrinks in one pass.

Google Play's percentages are measured on the DEX, which is exactly the R8 half. So when people say "enable R8 in MAUI", they mean making that Java half smaller and, eventually, renamed.

The shrinking alone is worth having. In [dotnet/android #12535](https://github.com/dotnet/android/issues/12535), a developer measured a .NET 10 app on 36.1.69 at 20.18 MB of uncompressed DEX with D8 and 11.43 MB with R8 and the default SDK rules. That is close to half the Java code gone, with no keep rules written by hand.

## The minimal project change

This is the whole configuration for a MAUI app targeting .NET 10 and .NET 11:

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

Then publish as usual:

```bash
dotnet publish -f net11.0-android -c Release
```

The `proguard.cfg` can start empty. You only add rules to it when R8 removes something that is reached by reflection, which is covered further down.

## What the SDK does when you set AndroidLinkTool

`AndroidLinkTool` is the only switch you need, because `Xamarin.Android.Common.targets` derives the rest from it. Condensed from the .NET 10 and .NET 11 targets:

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

A few consequences fall out of that:

- `AndroidLinkTool=proguard` is quietly upgraded to `r8`, because desugaring is on by default with D8. The standalone ProGuard tool is not used by modern .NET for Android.
- The old Xamarin-era `AndroidEnableProguard=true` / `EnableProguard=true` still works, but produces warning XA1028 (or XA1027) and defaults the link tool to `proguard`, which then becomes `r8`. Set `AndroidLinkTool` directly and skip the warning.
- A `mapping.txt` is produced in `$(OutputPath)` by default (for example `bin/Release/net11.0-android/mapping.txt`), and `dotnet publish` copies it to the publish folder. When you build an `.aab`, the mapping file is also embedded in the bundle metadata as `com.android.tools.build.obfuscation/proguard.map`, so Play Console picks it up without a manual upload. For a sideloaded `.apk`, you upload it yourself.

## Why R8 needs trimming turned on

R8 cannot work out by itself which Java types your C# still uses. That list comes from the .NET trimmer: after ILLink runs, a custom step writes `proguard_project_references.cfg` with a keep rule for every Java type that a surviving managed type binds to. The target that generates it is conditioned on trimming:

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

The decision to run R8 does not check trimming, though. `Xamarin.Android.D8.targets` only needs the path property to be set, and `_ResolveAssemblies` sets it for every build where `AndroidLinkTool` is non-empty:

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

So with `PublishTrimmed=false` (or `AndroidLinkMode=None` in Release, a common workaround for reflection problems), R8 still runs, but without the file that protects your bindings. The build only logs XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found"), and the app then dies with `java.lang.ClassNotFoundException` the first time it touches a Java type R8 removed. That exact sequence is [dotnet/android #6612](https://github.com/dotnet/android/issues/6612), where the maintainers confirmed that R8 depends on the .NET linker being enabled.

That is also why the Release condition in the project file is not cosmetic. Debug builds do not trim, so an unconditional `AndroidLinkTool=r8` makes Debug run R8 without the references file as well, and with fast deployment on you also get XA0119: "Using fast deployment and a code shrinker at the same time is not recommended".

## Which configuration files R8 actually receives

When R8 runs, the SDK assembles its `--pg-conf` inputs in this order (`_ProguardConfiguration` items in `Xamarin.Android.Common.targets`):

1. `$(ProguardConfigFiles)`, if you set that property.
2. The Android SDK's `proguard-android.txt` (non-optimizing baseline). On newer SDKs with `AndroidR8ObfuscationMode=private-members`, this becomes `proguard-android-optimize.txt`.
3. `obj/.../proguard/proguard_xamarin.cfg`: runtime keep rules for `mono.android.**`, `net.dot.jni.**`, and friends. On the shipping SDKs, this file starts with `-dontobfuscate`.
4. `proguard_project_references.cfg`: keep rules for every Java type that a surviving managed type binds to, generated after ILLink.
5. `proguard_project_primary.cfg`: one `-keep class X { *; }` rule per Java Callable Wrapper from the ACW map, so every `Activity`, `Service`, and custom `View` your C# defines survives.
6. Your `@(ProguardConfiguration)` items.
7. Consumer rules (`proguard.txt`) extracted from referenced `.aar` files.

Items 4 and 5 are why a MAUI app rarely needs hand-written keep rules for its own types: the build already knows which Java classes the managed side can reach. What it cannot know is what Java code reaches by reflection.

## Why you get shrinking but no obfuscation today

ProGuard options are global. If any configuration file says `-dontobfuscate`, obfuscation is off for the entire R8 run, and there is no opposite flag you can add in your own `proguard.cfg` to turn it back on. Because `proguard_xamarin.cfg` in 36.1.69 and 37.0.0-rc.1.2257 contains that line, an R8-enabled MAUI build on either SDK shrinks and optimizes but keeps every Java name intact. The `mapping.txt` it writes still records removed members and line-number changes, but it will not show renames.

The measurements in #12535 match: 34 of 15,235 classes renamed in one app's `mapping.txt` (0.2%), and Play Console reporting 1% obfuscation for another. Setting `AndroidCreateProguardMappingFile=true`, which some answers suggest, changes nothing here; it only controls whether the mapping file is written.

The blanket `-dontobfuscate` was the safe choice. JNI binds managed peers to Java classes by name, so renaming a Java Callable Wrapper or a bound AndroidX method would break `JNIEnv` lookups at runtime. The same thread found that removing the line by hand is not enough either: the generated keep rules did not protect fields that bindings read by name through JNI, so apps crashed at startup. Wait for the supported switch below instead of patching the SDK's configuration.

## Turning on real obfuscation with AndroidR8ObfuscationMode

[dotnet/android #12668](https://github.com/dotnet/android/pull/12668), merged on September 10, 2026, replaces the blanket rule with a selective one and adds a public property:

| `AndroidR8ObfuscationMode` | Obfuscation | Optimization baseline | Default |
|---|---|---|---|
| `disabled` | none, all Java names preserved | `proguard-android.txt` | .NET 10 servicing |
| `private-members` | private and package-private members renamed | `proguard-android-optimize.txt` | .NET 11 after RC 1 |

The same day, [#12752](https://github.com/dotnet/android/pull/12752) backported it to `release/10.0.1xx` with `disabled` as the default, so a servicing update does not change existing apps. No released tag contains it yet (36.1.69 predates it, and `release/11.0.1xx-rc1` was cut before the merge), so expect it in .NET 11 RC 2 and the next .NET 10 servicing update.

In `private-members` mode, the R8 task writes these rules in place of `-dontobfuscate`:

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

Read that as: every class keeps its name, every public and protected member keeps its name, and anything private or package-private may be renamed. Unused code can still be removed. The interface rules exist because managed proxy selection calls `Class.getInterfaces()`, which R8 cannot see; without them, class merging could drop an interface relationship and hand managed code the wrong proxy.

To opt in on .NET 10 once the servicing release lands, or to opt out on .NET 11:

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

Any other value fails the build with XA1050: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value". The PR also removes the undocumented `_AndroidR8DontObfuscate` and `_AndroidR8DontOptimize` switches, so drop them from your project if you copied them from an issue thread.

Keep your expectations calibrated. The PR reports that Google Play measured a `dotnet new maui -sc` template at 62% optimization, 65% shrinking, and 28% obfuscation. That clears the 25% bar, but obfuscation is the tight one, because JNI-visible names cannot be renamed. Treat `private-members` as "enough for the Play requirement", not as protection for your C# logic.

## Writing keep rules that actually matter

R8 only removes Java code it can prove is unreachable. The code you need rules for is code reached in ways R8 cannot see:

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

Two diagnostic rules are worth adding temporarily while you tune this, because your own `ProguardConfiguration` file is treated as application config and may use global options:

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

R8 resolves those relative paths against the folder of the config file, so both land next to `proguard.cfg`. Search `r8-merged.txt` for `-dontobfuscate` to confirm which obfuscation behavior your SDK applied, and search `r8-usage.txt` for a class name to prove R8 removed it before you write a rule for it. Remove both lines before you commit, because they add time to every Release build.

## Gotchas that bite in practice

- **Missing class warnings are hidden by default.** `AndroidR8IgnoreWarnings` defaults to `True`, which adds `-ignorewarnings` and (since .NET 8) passes `--map-diagnostics warning info`, so R8's "Missing class" messages show up as info lines in a detailed build log. That is why issues like [dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) usually do not fail the build. Setting it to `False` is stricter and can turn a missing class into a build error. Fix it with a targeted `-dontwarn`, not by flipping the global switch back.
- **A misspelled path is only a warning.** If the `ProguardConfiguration` path does not exist, you get XA4304 ("ProGuard configuration file '...' was not found") and R8 runs without your rules. Treat XA4304 as an error in CI with `<WarningsAsErrors>XA4304</WarningsAsErrors>`.
- **`EnableR8` and `AndroidLinkMode=r8` do nothing.** Neither exists as an R8 switch. MSBuild silently accepts unknown properties, and `AndroidLinkMode` only drives the managed trimmer (`None`, `SdkOnly`, `Full`). Only `AndroidLinkTool=r8` turns R8 on.
- **Library rules with global options are skipped.** Starting with .NET 11 Preview 7, a `proguard.txt` inside an `.aar` that contains `-dontobfuscate`, `-dontoptimize`, `-printmapping`, or similar is dropped with XA4322, which is the same restriction AGP 9 introduced. If a vendor library suddenly crashes after the upgrade, check the build log for XA4322 and copy its keep rules (minus the global option) into your own `proguard.cfg`.
- **The MS Learn build-item page is out of date.** It says `ProguardConfiguration` files are ignored unless `EnableProguard` is `True`. With `AndroidLinkTool=r8`, `AndroidEnableProguard` is forced to `True` for you, so the items are used.
- **Obfuscated stack traces need the mapping file.** Once `private-members` is on, private Java frames in a crash report read like `a.b.c`. Keep `mapping.txt` from every Release build you ship (the `.aab` carries it to Play, crash reporters like Firebase Crashlytics need it uploaded separately).
- **R8 costs build time.** Expect Release builds to take noticeably longer, since R8 does whole-program analysis over all the AndroidX and Play services bytecode. Keep it in Release only.

## Checking that R8 really ran

Do not trust the property alone; confirm it from build output:

1. Build with a binary log: `dotnet publish -f net11.0-android -c Release -bl`. Open `msbuild.binlog` in the MSBuild Structured Log Viewer and search for the `R8` task under `_CompileToDalvik`. If you only find `D8`, the property never reached the Android build, usually because its condition does not match your `TargetFramework`. If R8 ran but the log contains XA4304 for `proguard_project_references.cfg`, trimming is off and the app will crash at runtime.
2. Check that `bin/Release/net11.0-android/mapping.txt` exists and has a fresh timestamp.
3. Open `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` (the exact RID folder depends on your `RuntimeIdentifiers`). On 36.1.69 or 37.0.0-rc.1.2257 it starts with `-dontobfuscate`. On an SDK with `AndroidR8ObfuscationMode=private-members`, it starts with the `-keep,allowshrinking,allowoptimization class **` block instead.
4. Upload the `.aab` to an internal testing track and read the optimization, shrinking, and obfuscation percentages in Play Console's app bundle explorer. That is the number Google enforces, so it is the one to watch. Play reads the percentages from an `r8.json` build-metadata file when the bundle has one, and otherwise estimates them from `mapping.txt`. The SDK starts packaging `r8.json` with [dotnet/android #12646](https://github.com/dotnet/android/pull/12646), which is on `release/10.0.1xx` and `main` but not in 37.0.0-rc.1.2257.

## Related reading

- If Play also rejected your bundle for native library alignment, the fix is covered in [Google Play rejecting a MAUI app for 16 KB page size](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).
- Switching the runtime changes the APK contents R8 works around, see [migrating a MAUI Android app from Mono to CoreCLR in .NET 11](/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/).
- The other Play requirement due this cycle is handled in [targeting Android API level 36 from .NET MAUI](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- When a Release build fails inside the Java toolchain rather than silently, start with [Gradle build failed to produce an .apk file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- The `-printusage` technique above is the same one used to rule R8 out in [Firebase Auth sign-in not persisting in a Flutter Android release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

## Sources

- [.NET for Android build properties](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`, `AndroidCreateProguardMappingFile`, `AndroidProguardMappingFile`, `AndroidR8IgnoreWarnings`)
- [.NET for Android build items](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`, `AndroidAppBundleMetaDataFile`)
- [D8 and R8 integration spec](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md) in dotnet/android
- [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) and [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg) at 37.0.0-rc.1.2257
- [dotnet/android #6612: R8 without the .NET linker](https://github.com/dotnet/android/issues/6612) and [#12535: unconditional -dontobfuscate vs the Play requirement](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: configurable private-member obfuscation and optimization](https://github.com/dotnet/android/pull/12668) and the [.NET 10 backport #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: reducing memory usage and improving device migration](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (February 2027 DEX optimization requirement)
- [DEX code optimization in Android vitals](https://developer.android.com/topic/performance/vitals/code-optimization) (10 MB / 50 MB DEX thresholds)
