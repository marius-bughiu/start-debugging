---
title: ".NET Framework 3.5 wird auf neuen Windows-Builds eigenständig: was bricht"
description: "Ab Windows 11 Build 27965 ist .NET Framework 3.5 keine optionale Windows-Komponente mehr. Hier erfahren Sie, was in CI, Provisioning und Golden Images bricht und wie Sie es beheben."
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "windows"
lang: "de"
translationOf: "2026/02/net-framework-3-5-is-going-standalone-on-new-windows-builds-what-breaks-in-automation"
translatedBy: "claude"
translationDate: 2026-04-29
---
Microsoft hat etwas geändert, das viele Entwickler und IT-Leute automatisiert und dann vergessen haben: Ab **Windows 11 Insider Preview Build 27965** ist **.NET Framework 3.5 nicht mehr als optionale Windows-Komponente enthalten**. Wenn Sie es benötigen, müssen Sie es nun als **eigenständigen Installer** beziehen.

Dies ist eine .NET Framework Geschichte, aber sie trifft Teams, die moderne Services in **.NET 10** und **C# 14** bauen, weil der Schmerz an Stellen auftaucht wie frischen Entwicklerrechnern, kurzlebigen CI-Agenten, Golden Images und abgeschotteten Netzwerken.

## Das wichtige Detail: "NetFx3" ist nicht mehr garantiert

Aus dem Beitrag:

-   Die Änderung gilt für **Build 27965 und zukünftige Plattform-Releases** von Windows.
-   Sie **betrifft Windows 10 nicht** und auch keine früheren Windows 11 Releases bis **25H2**.
-   Sie ist an die Lifecycle-Realität gebunden: **.NET Framework 3.5 nähert sich dem Support-Ende am 9. Januar 2029**.

Wenn Ihre Skripte davon ausgehen, "Funktion aktivieren und Windows kümmert sich darum", erwarten Sie Brüche auf der neueren Linie.

## Was Ihr Provisioning jetzt tun sollte

Behandeln Sie .NET Framework 3.5 als eine Abhängigkeit, die Sie explizit bereitstellen und verifizieren. Mindestens:

-   Erkennen Sie Windows-Build-Versionen, die das neue Verhalten zeigen.
-   Prüfen Sie, ob `NetFx3` auf der Maschine abgefragt und aktiviert werden kann.
-   Falls nicht, folgen Sie der offiziellen Anleitung für den eigenständigen Installer und die Kompatibilitätshinweise.

Hier ist eine praktische Absicherung, die Sie in das Provisioning Ihres Build-Agenten oder in einen "Preflight"-Schritt einbauen können:

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

Das installiert nichts von selbst. Es macht den Fehler explizit, früh und leicht interpretierbar, wenn ein Maschinen-Image sich still unter Ihnen geändert hat.

## Das "Warum", auf das Sie jetzt reagieren sollten

Selbst wenn Sie migrieren wollen, haben Sie wahrscheinlich noch:

-   Interne Tools oder Hersteller-Apps, die 3.5 benötigen
-   Test-Suites, die alte Utilities starten
-   Kunden mit langen Upgrade-Zyklen

Der unmittelbare Gewinn ist also nicht "auf 3.5 bleiben". Der unmittelbare Gewinn ist, Ihre Umgebung berechenbar zu machen, während Sie auf unterstützte Ziele hinarbeiten.

Quellen:

-   [.NET Blog Post: .NET Framework 3.5 wechselt zu eigenständiger Bereitstellung](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   [Microsoft Learn Anleitung: Installer, Kompatibilität und Migration](https://go.microsoft.com/fwlink/?linkid=2348700)
