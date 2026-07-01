---
title: "SkiaSharp 4.0 ist stabil: 24% schnelleres GPU-Rendering und eine aufgeraeumte API"
description: "SkiaSharp 4.148.0 ist das erste stabile v4-Release. GPU-lastige Oberflaechen rendern bis zu 24% schneller, CPU-Shader laufen ~6x schneller, und die alte API-Oberflaeche wird endlich entfernt. Das kostet ein Upgrade wirklich."
pubDate: 2026-07-01
tags:
  - "skiasharp"
  - "dotnet"
  - "graphics"
  - "maui"
  - "performance"
lang: "de"
translationOf: "2026/07/skiasharp-4-0-stable-release-faster-gpu-rendering"
translatedBy: "claude"
translationDate: 2026-07-01
---

Matthew Leibowitz [kuendigte am 29. Juni 2026 das erste stabile SkiaSharp-4.0-Release an](https://devblogs.microsoft.com/dotnet/skiasharp-4-0-stable/), veroeffentlicht als NuGet-Paket `SkiaSharp 4.148.0`. Dies ist das Release, das jede v4-Preview in ein Paket zusammenfasst, das Sie in Produktion einsetzen koennen, und wenn Sie die Previews (hier behandelt in [SkiaSharp 4.0 Preview 1](/de/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/)) aufgeschoben haben, bis sich die API festigt: die API hat sich jetzt gefestigt.

## Der Leistungsgewinn ist real

Die Schlagzeile ist keine Funktion, sondern eine Zahl. Auf dem hardwarebeschleunigten GPU-Backend rendert die Arbeit, die moderne App-Oberflaechen dominiert (erhoehte Karten, Schlagschatten, geschichtete Flaechen), bis zu 24% schneller als das vorherige stabile Release. Microsofts eigene Zahlen, gemessen unter Windows 11 mit .NET 10 ueber OpenGL: ein Dashboard mit beschatteten Karten stieg von 65 auf 80 FPS, und ein scrollender Aktivitaets-Feed ging von 47 auf 58 FPS.

CPU-gebundene Arbeit verbesserte sich noch staerker. Prozedurale Perlin-Noise-Shader, wie Sie sie fuer Textur- oder Nebeleffekte einsetzen wuerden, laufen etwa 6-mal schneller. Fuer MAUI-, Avalonia- und Uno-Apps, die sich beim benutzerdefinierten Zeichnen auf SkiaSharp stuetzen, ist das eine kostenlose Verbesserung Ihres Frame-Budgets ohne Codeaenderung auf dem heissen Pfad.

## Was 4.148.0 tatsaechlich liefert

Drei konkrete Ergaenzungen erreichen die stabile API:

- Volle Achsensteuerung fuer variable OpenType-Schriften in SkiaSharp und HarfBuzzSharp, sodass Sie `wght`, `wdth` oder jede benutzerdefinierte Achse aus verwaltetem Code setzen, statt auf native HarfBuzz-Handles zurueckzugreifen.
- Farbpaletten fuer Emoji- und Icon-Schriften.
- Codierung von animiertem WebP.

Der Pfad ueber variable Schriften ist der, zu dem die meisten Apps zuerst greifen:

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

## Der Teil, den die Ankuendigung herunterspielt

"Eine sauberere und korrektere API" ist die diplomatische Formulierung. Praktisch uebersetzt: v4 schliesst eine lange Migration ab, und die alte API-Oberflaeche wird entfernt. Wenn Ihr Code noch veraltete 3.x-Member aufruft oder Sie eine eigene Steuerelement-Bibliothek gegen das veraenderliche `SKPath`-Modell gebaut haben, erfahren Sie es beim Kompilieren. Das unveraenderliche Muster aus `SKPath` plus `SKPathBuilder`, eingefuehrt in den Previews, ist jetzt der Standard, sodass jede Zeichenschleife, die einen zwischengespeicherten Pfad veraendert hat, auf einen Builder umsteigen muss.

Fuer die meisten Verbraucher ist das Upgrade eine Aenderung von einer Zeile:

```xml
<PackageReference Include="SkiaSharp" Version="4.148.0" />
```

Machen Sie das in einem Branch, kompilieren Sie und lesen Sie die Warnungen, bevor Sie die Release Notes lesen. Ein gruener Build bedeutet, dass Sie bereits sauber waren. Ein roter ist eine kurze, mechanische Liste entfernter Aufrufe, keine Neuschreibung. So oder so sind die FPS den Nachmittag wert.

Alle Details finden Sie im [SkiaSharp-4.148.0-Release auf GitHub](https://github.com/mono/SkiaSharp/releases).
