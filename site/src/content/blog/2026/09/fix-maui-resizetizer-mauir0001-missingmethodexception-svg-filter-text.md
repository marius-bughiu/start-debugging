---
title: "Fix: MAUIR0001 MissingMethodException in .NET MAUI Resizetizer on an SVG with <filter> or <text>"
description: "MAUI 10.0.101 and 10.0.110 Resizetizer ship mismatched System.Memory references, so SVGs with filters or text fail. Pin Resizetizer 10.0.100 or strip the filter and text."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
---

If your .NET MAUI 10 build started failing with `error MAUIR0001: There was an exception processing the image` and a `System.MissingMethodException` for `SKImageFilter.CreateMatrixConvolution`, `SKTextBlobBuilder.AddPositionedRun` or `SKTypeface.Clone`, the cause is the Resizetizer package itself, not your SVG. `Microsoft.Maui.Resizetizer` 10.0.101 and 10.0.110 bundle a SkiaSharp 4.150.1 build that asks for `System.Memory` 4.0.5.0 next to an `Svg.Skia` that asks for 4.0.2.0, and MSBuild loads two different `ReadOnlySpan<T>` types. Any SVG that uses a `<filter>` or `<text>` element crashes. The fastest fix is to pin `Microsoft.Maui.Resizetizer` to 10.0.100 while keeping the rest of MAUI on 10.0.110; the durable fix is to remove filters and convert text to paths in your `MauiIcon`, `MauiSplashScreen` and `MauiImage` SVGs.

## The error in context

Two variants of the error were reported upstream. The filter variant, from [dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319):

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

The text variant on 10.0.101, from [dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507):

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

On 10.0.110 the text variant moved to a different method, because 10.0.110 bumped `Svg.Skia` from 5.1.1 to 5.2.3 and the new version resolves fonts differently. This is what I get on 10.0.110 with a plain `<text>` element:

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

A comment on #38507 also reports a `HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)` flavor of the same exception from the iOS `GenerateSplashStoryboard` step. Whatever the method name, look at the signature: every one of them takes a `ReadOnlySpan<T>`. That is the whole bug.

## Why the Resizetizer can't find a method that exists

The first thing everyone does is open `SkiaSharp.dll` in a decompiler and find the method sitting right there. The reporter of #38507 did exactly that and confirmed by reflection that `AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)` is present. I did the same with `System.Reflection.Metadata` against the `buildTransitive` folder of each package version, and it checks out: the methods exist in 10.0.100, 10.0.101 and 10.0.110.

The difference is in the assembly references. Here is what each bundled assembly asks for:

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharp wants System.Memory | Svg.Skia wants System.Memory | System.Memory.dll shipped |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

The SkiaSharp bump came in via [dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731) ("Update SkiaSharp to 4.150.1"), which was backported to the 10.0.1xx servicing branch and shipped in 10.0.101.

Now look at how `dotnet build` loads a task's dependencies. MSBuild on .NET puts every task assembly in its own `MSBuildLoadContext`. When a dependency is requested, it probes the task's folder, and in [`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs) it skips the local file if the local version is lower than the requested one:

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

So in 10.0.101 and 10.0.110:

1. `Svg.Skia` asks for `System.Memory` 4.0.2.0. The task folder has 4.0.2.0, so MSBuild loads that file into the plugin context. That `System.Memory.dll` is the out-of-band netstandard2.0 package build, which **defines its own** `System.ReadOnlySpan<T>` type.
2. `SkiaSharp` asks for `System.Memory` 4.0.5.0. The local 4.0.2.0 is too old, so the probe falls through to the default context, which resolves the shared framework's `System.Memory` facade. That facade type-forwards `ReadOnlySpan<T>` to `System.Private.CoreLib`.
3. `Svg.Skia` compiles a call to `SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [from System.Memory.dll], ...)`. `SkiaSharp` exposes `CreateMatrixConvolution(..., ReadOnlySpan<float> [from CoreLib], ...)`. Same name, same text, different type identity. The runtime can't bind it and throws `MissingMethodException` when it JIT-compiles the calling method.

This also explains why the #38319 trace names `CreateMatrixConvolution` even though the repro SVG only uses `feGaussianBlur`: the exception fires when `Svg.Skia.SkiaModel.ToSKImageFilter` is JIT-compiled, and that method contains the call for every filter primitive. Any SVG with any `<filter>` reaches it. SVGs without filters or text never touch a span-taking SkiaSharp API during rasterization, which is why the default template icon still builds.

To prove the mechanism, I copied the 10.0.110 `buildTransitive` folder, deleted only `System.Memory.dll`, and pointed the task at the copy. Both failing SVGs rasterized fine, because now every request for `System.Memory` lands on the framework facade and there is only one `ReadOnlySpan<T>`. Don't ship that hack, but it confirms the diagnosis.

## Minimal repro

You don't need the MAUI workload to reproduce this, because the Resizetizer is an ordinary MSBuild task. Extract `microsoft.maui.resizetizer.10.0.110.nupkg` and run the task directly:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

With two test images:

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

Running `dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>` against each package gave me this on macOS with SDK 10.0.302:

| Resizetizer | plain SVG | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

Switching `PlatformType` to `ios` fails the same way on 10.0.110, so 10.0.110 did not fix either variant on either platform in my tests. As of today, #38319 and #38507 are open, and the proposed fix, [dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883), is a draft that swaps the bundled SkiaSharp to its netstandard2.0 build. Its CI run surfaced native library mismatches, so don't count on it landing in the next service release.

## Fix 1: pin Microsoft.Maui.Resizetizer to 10.0.100

The Resizetizer is build-time only. It generates PNGs and resource files; nothing from it ships in your app. That makes it safe to hold it back one version while the rest of MAUI stays on 10.0.110.

The MAUI SDK adds `Microsoft.Maui.Resizetizer` as an implicit `PackageReference` at `$(MauiVersion)`, but the targets remove the implicit item when you declare an explicit one with the same name. `Microsoft.Maui.Controls` 10.0.110 also depends on `Microsoft.Maui.Resizetizer >= 10.0.110`, so a plain downgrade fails restore:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

Suppress `NU1605` on that one reference only, so you don't hide real downgrades elsewhere:

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

I verified that this restores cleanly and that `project.assets.json` resolves `Microsoft.Maui.Resizetizer/10.0.100`. If you use Central Package Management, put the `Version` on a `PackageVersion` item and keep `NoWarn="NU1605"` on the `PackageReference`.

The bluntest alternative, which both issue reporters used, is to pin all of MAUI back with `<MauiVersion>10.0.100</MauiVersion>`. That works, but you give up every fix in 10.0.110 to work around a build task. Only do it if you already have a reason to hold MAUI back.

## Fix 2: remove filters and text from the SVGs the Resizetizer processes

This is the fix I'd keep even after upstream ships a patch, because it also makes your icons render the same everywhere. The Resizetizer rasterizes SVGs with `Svg.Skia`, which is not a browser. Text depends on fonts present on the build machine (your macOS CI runner and your Windows laptop will pick different fallbacks), and SVG filters have always been the least faithful part of any non-browser renderer.

Convert text to outlines. In Inkscape 1.x you can do it from the command line, which is handy for a folder of assets:

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

In Figma, use "Outline stroke" / "Flatten" on the text layer before exporting; in Illustrator, "Create Outlines". Keep the editable source file somewhere outside `Resources/` so the Resizetizer never sees it.

For filters, you have two options:

- Replace the effect with geometry. A drop shadow on an app icon is usually a second shape with lower opacity, offset by a few pixels. A soft glow can be a radial gradient. Neither needs `<filter>`.
- Rasterize the effect layer yourself and use a PNG. `MauiIcon` and `MauiSplashScreen` accept PNGs, and PNGs never go through `Svg.Skia`. Export at the largest size you need (1024x1024 for an iOS app icon). Per the [app icon docs](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons), a bitmap used as the main image is only resized when you set `BaseSize`, so the simplest setup keeps an SVG background and moves the effect into a PNG foreground:

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

To find every affected file before CI does, grep for the two element names:

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## Fix 3: move to MAUI 11 if you were going to anyway

The .NET MAUI 11 RC 1 Resizetizer (`11.0.0-rc.1.26451.6`) still bundles SkiaSharp 3.116.1 and a matching `Svg.Skia` 2.0.0.4, and all three test SVGs rasterized fine with it. That is not a reason to jump to a release candidate for one build error, but if the upgrade is already scheduled, this problem goes away with it. Keep in mind that the 10.0.1xx servicing branch picked up SkiaSharp 4.150.1 first, so a later MAUI 11 build may inherit the same pairing if it is not fixed at the source.

## Gotchas and lookalikes

- **It passes locally and fails in CI.** The Resizetizer is incremental. If the PNGs were generated by an earlier build on 10.0.100, the target is skipped and your local build stays green after the upgrade. Clean builds on CI regenerate them and fail. Run `dotnet clean` or delete `obj/` locally to see the real state.
- **`dotnet build-server shutdown` doesn't help.** This is not a stale MSBuild node holding an old SkiaSharp. The #38319 reporter confirmed it reproduces with `-nodeReuse:false`, and my repro uses that flag too.
- **Adding a SkiaSharp `PackageReference` to your app doesn't help.** The task loads the copies from the package's `buildTransitive` folder, not from your app's dependency graph. This is also why the upgrade produced no NuGet warning.
- **Different MAUIR0001 causes exist.** `MAUIR0001` is the Resizetizer's generic "exception processing the image" code. An `ArgumentNullException` or `Unable to allocate pixels for the bitmap` under the same code is a different problem with its own upstream issues (for example [dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)). Only the `MissingMethodException` with a `ReadOnlySpan` parameter is this bug.
- **Fonts in `MauiFont` are unaffected.** The crash is only in SVG rasterization. Your runtime text rendering, including custom fonts, doesn't touch this code.
- **Assembly load failures in your own app look similar but aren't.** If you get `MissingMethodException` or `FileLoadException` at runtime rather than during the build, see [how to fix Could not load file or assembly in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) instead.

## Related

- If the Android build also fails right after the Resizetizer step, [fixing "Gradle build failed to produce an .apk file" in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) covers the next most common CI break.
- For iOS CI runners that also stopped building after an SDK update, see [Unable to find a valid iOS Simulator runtime during a MAUI build](/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/).
- The Resizetizer asset pipeline and the `MauiIcon` / `MauiSplashScreen` items are walked through in [migrating from Xamarin.Forms to .NET MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- Store packaging regenerates all icon sizes, so [packaging a .NET MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) is where a filtered SVG icon will bite on Windows.

## Sources

- [dotnet/maui#38319: Resizetizer fails on any SVG app icon containing a `<filter>`](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101 fails on SVG `<text>` elements](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: Update SkiaSharp to 4.150.1](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Fix Resizetizer loading incorrect SkiaSharp assembly (draft)](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [Microsoft.Maui.Resizetizer on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [Add images to a .NET MAUI app project (MS Learn)](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)
