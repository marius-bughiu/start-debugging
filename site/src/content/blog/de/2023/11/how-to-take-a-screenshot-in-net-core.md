---
title: "Einen Windows-Desktop-Screenshot mit .NET aufnehmen"
description: "Ein lauffähiges .NET-Konsolenbeispiel nur für Windows: virtuellen Bildschirm erfassen, Zeichenressourcen freigeben und PNG speichern."
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dieses Beispiel erfasst mit Windows Forms und `System.Drawing` das umschließende Rechteck des virtuellen Bildschirms der aktuellen Windows-Desktopsitzung. Es ist eine Windows-Anwendung, auch wenn das Projekt ein Konsolenprogramm ist.

**Korrektur — 2. November 2026:** Der fehlende Quellcode wurde mit vollständigen Projekteinstellungen, Ressourcenfreigabe, Behandlung des Ausgabeordners und einem Selbsttest mit synthetischem Bild wiederhergestellt. Er wurde unter macOS für Windows gebaut; eine echte Windows-Bildschirmaufnahme wurde bei dieser Prüfung nicht ausgeführt.

## Download und Projekteinstellungen

[Lauffähigen Quellcode herunterladen](/examples/windows-screenshot.zip). Die Projektdatei enthält:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
```

`UseWindowsForms` stellt den Verweis auf das Windows-Desktop-Framework bereit. `EnableWindowsTargeting` erlaubt einen Cross-Build, wenn die Targeting-Packs wiederhergestellt werden können; die Anwendung wird dadurch nicht unter macOS oder Linux ausführbar.

## Den virtuellen Bildschirm erfassen

Das vollständige Programm enthält Imports und einen STA-Einstiegspunkt. Die Aufnahme erfolgt so:

```cs
var screen = SystemInformation.VirtualScreen;
using var bitmap = new Bitmap(screen.Width, screen.Height);
using (var graphics = Graphics.FromImage(bitmap))
{
    graphics.CopyFromScreen(
        screen.Left, screen.Top, 0, 0, screen.Size,
        CopyPixelOperation.SourceCopy);
}
bitmap.Save(filename, ImageFormat.Png);
```

`screen.Left` und `screen.Top` können negativ sein, wenn ein weiterer Monitor links oder oberhalb des Hauptbildschirms liegt. Das umschließende Rechteck kann ungenutzte Bereiche zwischen Bildschirmen enthalten. Andere Sitzungen, sichere Desktops oder geschützte Inhalte werden damit nicht garantiert erfasst.

Das Programm erstellt den Ausgabeordner und einen eindeutigen PNG-Dateinamen und gibt Bitmap- und Graphics-Objekte frei.

## Unter Windows ausführen

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

Der Selbsttest erzeugt und dekodiert eine synthetische PNG-Datei, ohne den Desktop aufzunehmen. Die normale Ausführung schreibt in den Bilderordner oder das angegebene Verzeichnis. Prüfe die echte Aufnahme in der vorgesehenen Windows-Sitzung einschließlich Monitoranordnung und DPI-Einstellungen.

Referenzen: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen), [Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen).
