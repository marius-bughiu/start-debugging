---
title: "SkiaSharp 4.0 Preview 1: Unveränderlicher SKPath, variable Schriften und ein neuer Co-Maintainer"
description: "SkiaSharp 4.0 Preview 1 erscheint mit Uno Platform als Co-Maintainer neben dem .NET-Team. SKPath wird hinter einem neuen SKPathBuilder unveränderlich, und HarfBuzzSharp erhält volle Achsensteuerung für variable OpenType-Schriften."
pubDate: 2026-04-29
tags:
  - "skiasharp"
  - "dotnet"
  - "maui"
  - "graphics"
  - "uno-platform"
lang: "de"
translationOf: "2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer"
translatedBy: "claude"
translationDate: 2026-04-29
---

David Ortinau [kündigte SkiaSharp 4.0 Preview 1 am 28. April 2026 an](https://devblogs.microsoft.com/dotnet/welcome-to-skia-sharp-40-preview1/), mit zwei Nachrichten, die wichtiger sind als der Versionssprung selbst: Uno Platform ist jetzt offizieller Co-Maintainer neben dem .NET-Team, und die Skia-Engine wurde in einer einzigen Version um Jahre an Upstream-Arbeit nach vorn gebracht.

## Ein co-gewartetes SkiaSharp

Bis zu diesem Release liefen SkiaSharp-Updates im Takt von Microsoft, der sich 2024 und 2025 sichtbar verlangsamt hatte, während sich der Fokus des Teams woanders hin verlagerte. Uno Platform formal als Co-Maintainer einzubinden, ist deshalb bedeutsam, weil Uno seit langem einen internen Fork (`unoplatform/Uno.SkiaSharp`) für WebAssembly pflegt, und dieser Fork war die Quelle für die meisten Engine-Aktualisierungen in dieser Vorschau ([PRs #3560](https://github.com/mono/SkiaSharp/pull/3560) und [#3702](https://github.com/mono/SkiaSharp/pull/3702)). Die praktische Wirkung: Grafiken in .NET MAUI, Avalonia-Controls, Uno-Apps und jeder Konsolen-Renderer, der SkiaSharp nutzt, fahren jetzt auf einem aktuellen Skia statt auf einem, das Chromium um ein Jahr oder mehr hinterherhinkte.

Build-Fixes für Android API 36, Generator-Tooling auf der Linux-Seite und eine überarbeitete WebAssembly-Galerie kamen alle über denselben Beitragssatz herein.

## SKPath wird unveränderlich

Die größte API-Änderung ist, dass `SKPath` jetzt intern unveränderlich ist. Die vertrauten mutierenden Methoden bleiben aus Gründen der Rückwärtskompatibilität bestehen, aber der moderne Weg, einen Pfad zu bauen, geht über den neuen `SKPathBuilder`:

```csharp
using var builder = new SKPathBuilder();
builder.MoveTo(50, 0);
builder.LineTo(50, -50);
builder.LineTo(-30, -80);
builder.Close();

using SKPath path = builder.Detach();
canvas.DrawPath(path, paint);
```

`Detach()` liefert das unveränderliche Ergebnis. Da der zugrunde liegende `SkPath` nach der Konstruktion nicht mehr mutiert, kann die Laufzeit Pfadgeometrie sicher zwischen Threads teilen, hashen und wiederverwenden, was für jedes UI-Framework wichtig ist, das Zeichenprimitive zwischen Frames cacht. Bestehender Code, der `path.MoveTo(...)` direkt aufruft, kompiliert und läuft weiter, sodass MAUI- und Xamarin.Forms-Apps nichts ändern müssen, um Preview 1 zu übernehmen.

## Variable Schriften über HarfBuzzSharp

Die andere herausragende Ergänzung ist die volle Achsensteuerung für variable OpenType-Schriften. HarfBuzzSharp legt jetzt die Achsen offen, die eine Schrift deklariert (Gewicht, Breite, Neigung, optische Größe oder beliebige benutzerdefinierte Achsen), und erlaubt Ihnen, Schriftvarianten zu erzeugen, ohne zehn statische Schriftdateien ausliefern zu müssen:

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

Vorher mussten Aufrufer auf native HarfBuzz-Handles hinabsteigen, um Achsenkoordinaten zu setzen. Preview 1 macht dieselben Steuerungen über schlichte verwaltete APIs in SkiaSharp und HarfBuzzSharp verfügbar.

## Die Vorschau holen

Das Paket ist hinter `aka.ms/skiasharp-40-package` veröffentlicht. Die Vorschau zielt auf dieselben Plattformen wie 3.x (`net8.0`, `net9.0`, `net10.0` plus die üblichen mobilen Heads), und das Team bittet um Feedback, bevor die API-Oberfläche für das stabile 4.0-Release fixiert wird. Wenn Sie eine eigene Skia-Control-Bibliothek pflegen, ist dies das Zeitfenster, um die unveränderliche Pfadsemantik gegen Ihren Zeichen-Loop zu testen und alles zu melden, was einen Pfad nach dem Cachen mutiert: genau dieses Muster geht von "funktioniert in 3.x" zu "braucht einen `SKPathBuilder`" in 4.0.

Für einen tieferen Durchgang veranstaltet Uno Platform am 30. Juni ein Focus on SkiaSharp Event mit Sessions der Ingenieure hinter diesem Release.
