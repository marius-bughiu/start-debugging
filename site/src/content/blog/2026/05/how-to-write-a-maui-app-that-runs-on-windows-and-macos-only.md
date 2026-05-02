---
title: "How to write a MAUI app that runs on Windows and macOS only (no mobile)"
description: "Strip Android and iOS from a .NET MAUI 11 project so it ships Windows and Mac Catalyst only: the csproj edits, the workload commands, and the multi-targeting that keeps your code clean."
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
---

Short answer: open your `.csproj`, delete the Android and iOS entries from `<TargetFrameworks>`, and leave only `net11.0-windows10.0.19041.0` and `net11.0-maccatalyst`. Then delete `Platforms/Android`, `Platforms/iOS`, and `Platforms/Tizen` if it exists. Remove the matching MAUI image-asset `<ItemGroup>` entries that point at mobile-only icons, drop the `maui-android` and `maui-ios` workloads if you want a clean machine, and your Single Project layout, `MauiProgram`, XAML hot reload, and resource pipeline continue to work. `dotnet build -f net11.0-windows10.0.19041.0` produces an MSIX, `dotnet build -f net11.0-maccatalyst` (run on macOS) produces an `.app`, and nothing tries to spin up an Android emulator ever again.

This post walks through the exact edits for .NET MAUI 11.0.0 on .NET 11, what is safe to delete and what is not, the subtle multi-targeting traps when you remove platform heads, and the workload and CI changes that actually save you time. Everything below was verified against `dotnet new maui` from the .NET 11 SDK and applies identically to a Xamarin.Forms project that has already been migrated to MAUI.

## Why ship a desktop-only MAUI head at all

There is a steady tail of line-of-business teams that pick MAUI for its XAML and binding model rather than its mobile reach. Internal admin tools, kiosk apps, point-of-sale clients, factory-floor dashboards, and field-service apps where the field is "a Surface and a MacBook" all fit. These teams pay a real cost for the mobile heads they never ship: every `dotnet build` evaluates four targets, every NuGet restore pulls Android and iOS reference packs, every CI runner needs an Android workload, and every developer onboarding hits an XCode and Android Studio dependency before they can run the app.

Stripping the mobile heads is not the default Visual Studio template, but it is fully supported by the SDK. The build system reads `<TargetFrameworks>` and only emits the heads you declare. There is no flag you have to flip in MAUI itself. The friction is entirely in the project file, the `Platforms/` folder, and the conditional MSBuild items that the template adds for mobile assets.

## The TargetFrameworks edit

A fresh `dotnet new maui -n DesktopApp` in the .NET 11 SDK produces a project that opens with this opening `PropertyGroup`:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Replace the two `<TargetFrameworks>` lines with one explicit list:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Two things matter here. First, the conditional `IsOSPlatform('windows')` block is preserved because the Windows head can only build on Windows, just as Mac Catalyst can only build on macOS. Without the condition, a developer on macOS running `dotnet build` would fail with "The Windows SDK is not available." Second, the version suffix on `net11.0-windows10.0.19041.0` is the Windows 10 SDK version that MAUI requires for WinUI; do not drop the version suffix or change it to `net11.0-windows10.0` alone, because the WinAppSDK targets pin to that specific moniker.

If you only want macOS, drop the Windows line entirely. If you only want Windows, drop the Mac Catalyst line and the conditional. The `<TargetFramework>` (singular) form works too if you genuinely only have one head, and that gives you a single non-conditional value that some tooling handles more gracefully. For a true cross-desktop app, keep the multi-target form.

## What to delete in `Platforms/`

The MAUI template gives you `Platforms/Android`, `Platforms/iOS`, `Platforms/MacCatalyst`, `Platforms/Tizen`, and `Platforms/Windows`. Each contains a small amount of platform-specific bootstrap code: an `AppDelegate` for Apple platforms, a `MainActivity` and `MainApplication` for Android, an `App.xaml` plus a `Package.appxmanifest` for Windows, an `Application.cs` for Mac Catalyst.

For desktop-only, delete `Platforms/Android`, `Platforms/iOS`, and `Platforms/Tizen` outright. They are not used. Keep `Platforms/MacCatalyst` and `Platforms/Windows`. Do not touch the `Resources/` folder at all; that is the Single Project asset pipeline and it serves all heads.

After deletion the layout looks like:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

That is the full source tree for a desktop-only MAUI 11 app.

## Strip the mobile-only image-asset items

If you used the default template, your `.csproj` has a block like this near the bottom:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

These are platform-agnostic and stay as-is. The Single Project resource pipeline turns the SVG into per-platform PNGs at build time only for the heads you declared. When you remove Android, no Android densities are emitted; the same `Resources/AppIcon/appicon.svg` file feeds Mac Catalyst's `AppIcon.icns` and Windows's `Square150x150Logo.scale-200.png` and that is all you need.

If your project predates .NET 9 you may also have explicit `<AndroidResource>` or `<BundleResource>` items left over from a Xamarin.Forms migration. Delete those. They will not error if you leave them, but they confuse the build output and you will hit "file not found" warnings if the referenced files no longer exist.

## Multi-targeting your own code without `#if ANDROID`

The MAUI template ships a couple of patterns for platform-specific code: `partial` classes split across `Platforms/<head>/` files, and `#if` directives. With Android and iOS gone, you only need to handle Windows and Mac Catalyst. The preprocessor symbols you actually use are:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

That is it. `ANDROID` and `IOS` are still defined symbols when those heads are present in `<TargetFrameworks>`, but since they are not, those branches simply never compile. You can safely delete every `#if ANDROID` and `#if IOS` block from your codebase as a separate cleanup pass.

If you split implementations by file name (the [official multi-targeting pattern documented for MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)), the conditional `<ItemGroup>` blocks should drop the Android and iOS branches:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

Two rules instead of five. The same logic applies to folder-based multi-targeting; keep only the `MacCatalyst` and `Windows` folder rules.

## Workloads: install what you build, uninstall what you don't

This is the change that pays for itself fastest on a CI runner. The MAUI workload manifest is split into several sub-workloads:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

For a desktop-only project you need exactly those two on the relevant runner. You do not need the umbrella `maui` workload, which pulls Android and iOS as transitive workload dependencies. On a CI image that already had `maui` installed, run:

```bash
dotnet workload uninstall maui-android maui-ios
```

The Mac Catalyst head on macOS still requires Xcode, since `mlaunch` and the Apple toolchain do the actual `.app` construction. You do not need the Android SDK, the Java JDK, or any iOS device-deployment dependencies. On Windows, the Windows head requires the Windows App SDK and the Windows 10 SDK at the version pinned in `<TargetFrameworks>`. The `dotnet workload install maui-windows` command pulls both.

The CI saving is meaningful. A Linux runner used to provision Android workloads and emulator images for a hosted Linux build of a MAUI app, only to skip them at the CI gate, can drop those steps entirely; the build now ignores Linux and you run two separate jobs, one per OS.

## Building and publishing each head

The `dotnet build` and `dotnet publish` commands take an explicit `-f` framework argument so you do not accidentally try to build a head on the wrong host:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

The Windows head emits an `.msix` package or, with `WindowsPackageType=None`, an unpackaged Win32 directory. The Mac Catalyst head emits a `.app` and, with `CreatePackage=true`, a `.pkg` installer. Code signing is a separate concern for both: an Authenticode certificate for the MSIX and an Apple Developer ID for the `.pkg`. Neither involves a provisioning profile, which is the iOS-specific dance you just opted out of.

If you also want Native AOT for the desktop heads, MAUI's WinUI head supports it on .NET 11 with caveats, similar to the [Native AOT path for ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Mac Catalyst does not support full Native AOT in MAUI 11 yet; it ships with mono-AOT for Apple platforms.

## Gotchas worth remembering

The Visual Studio "Add new MAUI Page" template silently re-adds an `<ItemGroup Condition="...android..."/>` block in some scenarios. Watch your csproj diffs. If you commit a clean desktop-only csproj and a teammate adds a new view through the IDE, the diff may resurrect the Android and iOS conditional items even though `<TargetFrameworks>` no longer includes those targets. Those orphan items are harmless but they will accumulate noise.

NuGet packages that depend on `Xamarin.AndroidX.*` or `Microsoft.Maui.Essentials` for mobile-only APIs will still restore. The package manager resolves against the targets you declare, and a mobile-only package with no compatible asset for `net11.0-windows10.0` or `net11.0-maccatalyst` will fail with `NU1202`. The fix is to remove the package; if it is a transitive dependency of something you actually use, file an issue with the upstream package and pin to a version that supports desktop targets explicitly.

XAML hot reload works on both desktop heads in .NET 11. The launching debugger has to be the host OS for the head: you cannot debug into a Mac Catalyst session from Visual Studio on Windows. Rider on macOS handles both heads from a single workspace, which is the workflow most cross-desktop teams settle on.

The MAUI Essentials APIs that are explicitly mobile-only (geocoding, contacts, sensors, telephony) throw `FeatureNotSupportedException` at runtime on Windows and Mac Catalyst. They do not fail at compile time. Wrap usage of those APIs behind a capability check or a desktop-safe abstraction. The same applies to MAUI Maps before the [pin clustering changes shipped in .NET MAUI 11](/2026/04/dotnet-maui-11-map-pin-clustering/); the desktop heads use a different map control under the hood than the mobile heads, and feature parity is not perfect.

If you ever need to add the mobile heads back (a customer asks for an iPad version), the changes reverse cleanly: add the entries back to `<TargetFrameworks>`, restore the `Platforms/Android` and `Platforms/iOS` folders from a fresh `dotnet new maui` template, reinstall the workloads. The Single Project layout, your XAML, your view models, and your resource pipeline carry over without changes. The desktop-only configuration is a strict subset of the four-head template, not a fork.

## Related

- [.NET MAUI 11 ships a built-in LongPressGestureRecognizer](/2026/04/maui-11-long-press-gesture-recognizer/)
- [Pin clustering lands in .NET MAUI 11 Maps](/2026/04/dotnet-maui-11-map-pin-clustering/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Source links

- [Configure .NET MAUI multi-targeting (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [Target frameworks in SDK-style projects (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Troubleshoot known issues, .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [`dotnet/maui` issue 11584 on Mac Catalyst target removal](https://github.com/dotnet/maui/issues/11584)
