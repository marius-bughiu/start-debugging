---
title: "SkiaSharp 4.0 Ships Stable: 24% Faster GPU Rendering and a Cleaned-Up API"
description: "SkiaSharp 4.148.0 is the first stable v4 release. GPU-heavy UIs render up to 24% faster, CPU shaders run ~6x faster, and the legacy API surface is finally retired. Here is what upgrading actually costs you."
pubDate: 2026-07-01
tags:
  - "skiasharp"
  - "dotnet"
  - "graphics"
  - "maui"
  - "performance"
---

Matthew Leibowitz [announced the first stable SkiaSharp 4.0 release on June 29, 2026](https://devblogs.microsoft.com/dotnet/skiasharp-4-0-stable/), shipping as NuGet package `SkiaSharp 4.148.0`. This is the release that rolls up every v4 preview into one package you can put in production, and if you held off on the previews (covered here in [SkiaSharp 4.0 Preview 1](/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/)) waiting for the API to settle, the API has now settled.

## The Performance Story Is Real

The headline is not a feature, it is a number. On the hardware-accelerated GPU backend, the work that dominates modern app UIs (elevated cards, drop shadows, layered surfaces) renders up to 24% faster than the previous stable release. Microsoft's own numbers, measured on Windows 11 with .NET 10 over OpenGL: a dashboard of shadowed cards climbed from 65 to 80 FPS, and a scrolling activity feed went from 47 to 58 FPS.

CPU-bound work moved even more. Procedural Perlin-noise shaders, the kind you would use for texture or fog effects, run about 6 times faster. For MAUI, Avalonia, and Uno apps that lean on SkiaSharp for custom drawing, this is a free upgrade to your frame budget with no code changes on the hot path.

## What Actually Ships in 4.148.0

Three concrete additions land in the stable API:

- Full OpenType variable font axis control across SkiaSharp and HarfBuzzSharp, so you set `wght`, `wdth`, or any custom axis from managed code instead of dropping to native HarfBuzz handles.
- Color font palettes for emoji and icon fonts.
- Animated WebP encoding.

The variable-font path is the one most apps will reach for first:

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
canvas.DrawText("One font file, every weight", 0, 0, font, paint);
```

## The Part the Announcement Underplays

"A cleaner and more correct API" is the polite framing. The practical translation: v4 completes a long migration and the legacy API surface is retired. If your code still calls deprecated 3.x members, or if you built a custom control library against the mutable `SKPath` model, the compile is where you find out. The immutable `SKPath` plus `SKPathBuilder` pattern introduced in the previews is now the default, so any draw loop that mutated a cached path needs to move to a builder.

For most consumers the upgrade is a one-line bump:

```xml
<PackageReference Include="SkiaSharp" Version="4.148.0" />
```

Do that on a branch, build, and read the warnings before you read the release notes. A green build means you were already clean. A red one is a short, mechanical list of retired calls, not a rewrite. Either way, the FPS is worth the afternoon.

Full details are in the [SkiaSharp 4.148.0 release on GitHub](https://github.com/mono/SkiaSharp/releases).
