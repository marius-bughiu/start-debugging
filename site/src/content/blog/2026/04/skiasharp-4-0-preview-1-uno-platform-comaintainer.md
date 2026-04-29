---
title: "SkiaSharp 4.0 Preview 1: Immutable SKPath, Variable Fonts, and a New Co-Maintainer"
description: "SkiaSharp 4.0 Preview 1 lands with Uno Platform as co-maintainer alongside the .NET team. SKPath becomes immutable behind a new SKPathBuilder, and HarfBuzzSharp gets full OpenType variable font axis control."
pubDate: 2026-04-29
tags:
  - "skiasharp"
  - "dotnet"
  - "maui"
  - "graphics"
  - "uno-platform"
---

David Ortinau [announced SkiaSharp 4.0 Preview 1 on April 28, 2026](https://devblogs.microsoft.com/dotnet/welcome-to-skia-sharp-40-preview1/), with two pieces of news that matter more than the version bump itself: Uno Platform is now an official co-maintainer alongside the .NET team, and the Skia engine has been jumped forward by years of upstream work in a single release.

## A Co-Maintained SkiaSharp

Until this release, SkiaSharp updates moved on Microsoft's cadence, which had slowed visibly in 2024 and 2025 while the team's focus shifted elsewhere. Pulling Uno Platform into a formal co-maintainer role is significant because Uno already ships a long-running internal fork (`unoplatform/Uno.SkiaSharp`) for WebAssembly, and that fork has been the source of most of the engine bumps in this preview ([PRs #3560](https://github.com/mono/SkiaSharp/pull/3560) and [#3702](https://github.com/mono/SkiaSharp/pull/3702)). The practical effect: .NET MAUI graphics, Avalonia controls, Uno apps, and every console renderer that uses SkiaSharp now ride on a current Skia instead of one that was lagging Chromium by a year or more.

Android API 36 build fixes, Linux-side generator tooling, and a refreshed WebAssembly gallery all came in through the same set of contributions.

## SKPath Goes Immutable

The biggest API change is that `SKPath` is now immutable under the hood. The familiar mutating methods stay in place for backward compatibility, but the modern way to build a path is through the new `SKPathBuilder`:

```csharp
using var builder = new SKPathBuilder();
builder.MoveTo(50, 0);
builder.LineTo(50, -50);
builder.LineTo(-30, -80);
builder.Close();

using SKPath path = builder.Detach();
canvas.DrawPath(path, paint);
```

`Detach()` hands you the immutable result. Because the underlying `SkPath` no longer mutates after construction, the runtime can share, hash, and reuse path geometry safely across threads, which matters for any UI framework that caches drawing primitives between frames. Existing code that calls `path.MoveTo(...)` directly continues to compile and run, so MAUI and Xamarin.Forms apps do not need to change anything to take Preview 1.

## Variable Fonts Through HarfBuzzSharp

The other headline addition is full OpenType variable font axis control. HarfBuzzSharp now exposes the axes a font declares (weight, width, slant, optical size, or any custom axis) and lets you create typeface variants without shipping ten static font files:

```csharp
using var blob = SKData.Create("Inter.ttf");
using var typeface = SKTypeface.FromData(blob);

var variation = new SKFontVariation
{
    { "wght", 650 },
    { "wdth", 110 },
};

using var variant = typeface.CreateVariant(variation);
using var font = new SKFont(variant, size: 24);
canvas.DrawText("Hello, variable fonts", 0, 0, font, paint);
```

Before this, callers had to drop down to native HarfBuzz handles to set axis coordinates. Preview 1 surfaces the same controls in plain managed APIs across SkiaSharp and HarfBuzzSharp.

## Pulling the Preview

The package is published behind `aka.ms/skiasharp-40-package`. The preview targets the same set of platforms as 3.x (`net8.0`, `net9.0`, `net10.0`, plus the usual mobile heads), and the team is asking for feedback before locking the API surface for the stable 4.0 release. If you maintain a custom Skia control library, this is the window to test the immutable path semantics against your draw loop and report anything that mutates a path after caching it -- that is the exact pattern that goes from "works in 3.x" to "needs an `SKPathBuilder`" in 4.0.

For a deeper walkthrough, Uno Platform is hosting a Focus on SkiaSharp event on June 30, with sessions from the engineers behind this release.
