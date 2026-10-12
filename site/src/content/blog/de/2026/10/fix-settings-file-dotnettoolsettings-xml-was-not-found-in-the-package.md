---
title: "Fix: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "Das Tool-Paket zielt auf ein neueres .NET als das SDK, das die Installation ausführt, oder es ist gar kein .NET-Tool. Verwenden Sie ein neueres SDK, pinnen Sie eine Tool-Version mit kompatiblem tools-Ordner oder erzwingen Sie --framework."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
lang: "de"
translationOf: "2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package"
translatedBy: "claude"
translationDate: 2026-10-12
---

Das Paket ist fast nie defekt, und das Leeren des NuGet-Caches hilft nicht. Diese Meldung bedeutet: Das SDK, das `dotnet tool install` ausführt, hat keinen `tools/<tfm>/`-Ordner gefunden, den es verwenden darf. Die übliche Ursache ist ein Tool, das nur für ein neueres .NET gebaut wurde als das SDK selbst, zum Beispiel `dotnet-ef` 10.0.0/10.0.1 oder 11.0 auf SDK 8 oder 9. Führen Sie `dotnet --version` in dem Ordner aus, in dem die Installation fehlschlägt. Wechseln Sie dann entweder zu einem SDK, das mindestens so neu ist wie das Zielframework des Tools, oder pinnen Sie eine Tool-Version, die einen älteren `tools/`-Ordner mitliefert (`dotnet-ef` 10.0.2 und später liefern wieder `net8.0` aus). Ist das Paket gar kein .NET-Tool (`Microsoft.EntityFrameworkCore.Tools`, `Microsoft.EntityFrameworkCore.Design`), installieren Sie stattdessen `dotnet-ef`. Alles Folgende wurde am 2026-10-12 mit SDK 8.0.425, 9.0.318 und 10.0.302 auf macOS arm64 gegen das echte nuget.org reproduziert.

## The error in context

`dotnet tool install` (global, `--tool-path` oder lokal) gibt Folgendes aus, selbst auf einem frischen Rechner, auf dem vorher nichts installiert war:

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" ist irreführend. Die Meldung erscheint auch bei einer Erstinstallation. `dotnet tool restore` und `dotnet dnx` durchlaufen denselben Codepfad, fangen die Ausnahme aber nicht ab. In einem Repository mit Tool-Manifest erhalten Sie daher die Rohform:

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

Beide Formen enden mit Exit-Code 1. Nichts in der Ausgabe verrät, nach welchem Framework das SDK gesucht hat. Deshalb löschen viele wahllos Caches und installieren SDKs neu.

## Why this happens

Ein .NET-Tool-Paket legt seine Nutzdaten unter `tools/<target framework>/<rid>/` ab, und `DotnetToolSettings.xml` liegt in diesem Ordner. Die Datei existiert also, aber nur innerhalb eines Framework-Ordners. Das SDK durchsucht nicht das ganze Paket danach. Es baut mit den Asset-Auswahlregeln von NuGet eine synthetische Assets-Datei und fragt das Element im **nächsten kompatiblen Framework-Ordner** ab. Im Quellcode des .NET 10 SDK (`ToolPackageDownloader.CreateAssetFile`) stammt das Zielframework von der Laufzeit, auf der die CLI läuft:

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

SDK 9.0.318 läuft auf der .NET-9-Laufzeit und fragt deshalb `net9.0` an. Ein Paket, das nur `tools/net10.0/any/` enthält, hat keinen kompatiblen Ordner, die Liste der ausgewählten Elemente bleibt leer. `ToolPackageInstance.DeserializeToolConfiguration` wirft dann `MissingToolSettingsFile`, also die Meldung, die Sie sehen. In der Praxis bedeutet der Text: "Kein `tools/`-Ordner zielt auf ein Framework, das dieses SDK ausführen kann."

Zwei Folgen überraschen viele:

1. **Installierte Laufzeiten zählen nicht.** Ich habe die .NET-10.0.12-Laufzeit neben SDK 9.0.318 installiert, und die einfache Installation von `dotnet-ef` 10.0.1 schlug trotzdem mit derselben Meldung fehl. Nur die Laufzeitversion des SDK selbst zählt.
2. **Die Prüfung des Pakettyps kommt später und nur in SDK 10.** SDK 10 prüft zuerst den `packageType` der nuspec und gibt für Nicht-Tool-Pakete ein klares "is not a .NET tool" aus. SDK 8 und 9 überspringen diese Prüfung und landen bei derselben irreführenden Meldung.

Hinter diesem einen Text stecken also drei echte Ursachen, nach Häufigkeit sortiert:

- **Das Tool zielt auf ein neueres .NET als Ihr SDK.** Das ist der Normalfall nach einem neuen Major-Release (`dotnet-ef` 10.0.0/10.0.1, `AzureSignTool` 7.0.0, jedes Tool, das nur für `net10.0` oder `net11.0` gebaut wurde).
- **Das Tool ist ein plattformspezifisches .NET-10-Tool (RID-spezifisch).** Sein Root-Paket hat ebenfalls nur einen `tools/net10.0/`-Ordner, ältere SDKs scheitern also genauso.
- **Das Paket ist kein Tool.** Es ist eine Bibliothek oder ein MSBuild-/PowerShell-Paket, das versehentlich mit `dotnet tool install` installiert wird.

## Minimal repro

Diese Befehle verwenden `--tool-path`, damit Ihr globaler Tools-Ordner unberührt bleibt. Jeder Block zeigt die SDK-Version, mit der er lief.

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

Die letzte Zeile ist wichtig. Das einfache `dotnet tool install dotnet-ef` löst heute zu 10.0.12 auf und funktioniert auf SDK 8 und 9. Der Fehler tritt nur auf, wenn eine Version gepinnt ist, etwa in einem `dotnet-tools.json`-Manifest oder einem CI-Skript, das im November 2025 geschrieben wurde. Hier ist das `tools/`-Layout jeder `dotnet-ef`-Version, die ich auf nuget.org geprüft habe:

| dotnet-ef-Version | tools-Ordner | Installierbar auf SDK 8 / 9 | Installierbar auf SDK 10 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | ja | ja |
| 9.0.10 | `tools/net8.0/any/` | ja | ja |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **nein** | ja |
| 10.0.2 bis 10.0.12 | `tools/net8.0/any/` | ja | ja |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **nein** | ja |

Dasselbe passiert eine Major-Version weiter oben. Ich habe ein triviales Tool so neu gepackt, dass sein einziger Ordner `tools/net11.0/any/` war, und SDK 10.0.302 lehnte es mit derselben Meldung ab. `dotnet dnx` auf SDK 10 gab für dasselbe Paket die "Unhandled exception"-Form aus.

## Fix, in detail

### 1. Check which SDK actually runs in that folder

`global.json` wählt das SDK pro Verzeichnis, das SDK, das `dotnet tool restore` in Ihrem Repository ausführt, ist also nicht unbedingt das neueste installierte:

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

Gibt `dotnet --version` `8.0.x` oder `9.0.x` aus und das Tool zielt auf `net10.0`, ist das Ihre Antwort. In der CI entsteht dieselbe Diskrepanz durch ein Runner-Image, das nur das alte SDK enthält, oder durch `actions/setup-dotnet`, das eine `global.json` liest, die 8.0 pinnt. Die [CI-Anleitung zu "the command dotnet could not be found"](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) erklärt, wie der Runner sein SDK auswählt.

### 2. Recommended: run the tool with an SDK at least as new as its target

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

Ein .NET-10-SDK baut `net8.0`- und `net9.0`-Projekte ohne Änderung, das SDK-Upgrade zwingt Sie also nicht, Ihre App neu zu targeten. Das ist die sauberste Lösung, weil auch alle anderen Tools in Ihrem Manifest davon profitieren. Planen Sie ohnehin den vollständigen Umstieg, listet die [Checkliste für .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) die zu erwartenden Breaking Changes auf SDK-Ebene auf.

### 3. If you cannot change the SDK: pin a tool version with a compatible folder

Bei `dotnet-ef` liefert jeder Build ab 10.0.2 `tools/net8.0/` mit und lässt sich auf SDK 8 und 9 installieren:

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

Das Tool braucht weiterhin eine Laufzeit, auf der es laufen kann. Der `net8.0`-Build von `dotnet-ef` 10.0.12 lief auf SDK 8.0.425 problemlos, mit nur der .NET-8-Laufzeit. Bei anderen Tools schauen Sie vor dem Pinnen ins Paket. Der Tab "Frameworks" auf nuget.org zeigt es, oder Sie listen das Archiv direkt auf:

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

Hat jede für Sie nutzbare Version nur einen neueren Ordner, gehen Sie zurück zu Fix 2.

### 4. Escape hatch: force the framework with `--framework`

`dotnet tool install` und `dotnet tool update` akzeptieren `--framework`, und dieser Wert ersetzt in der oben beschriebenen Asset-Auswahl `Environment.Version`. Ist die neuere Laufzeit parallel installiert, kann ein altes SDK ein neueres portables Tool installieren:

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

Ohne die .NET-10-Laufzeit "gelingt" die Installation zwar trotzdem, aber das Tool scheitert beim ersten Start. Auf SDK 8.0.425 mit nur .NET 8 meldete `dotnet-ef` "You must install or update .NET to run this application" und verlangte `Microsoft.NETCore.App` 10.0.0. `dotnet tool restore` hat keine Option `--framework`, das hilft also nur bei globalen und `--tool-path`-Installationen. Betrachten Sie es als Notbehelf, nicht als Pipeline-Lösung.

### 5. If the package is not a tool: install the right package

`Microsoft.EntityFrameworkCore.Tools` ist das Package-Manager-Console-Paket für Visual Studio, und `Microsoft.EntityFrameworkCore.Design` ist die Design-Time-Bibliothek, die Ihr Startprojekt referenziert. Beides ist kein .NET-Tool. Was jedes SDK ausgibt, hängt von der Version ab:

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

Das CLI-Tool heißt `dotnet-ef`. Fügen Sie `Microsoft.EntityFrameworkCore.Design` Ihrem Startprojekt als normale `PackageReference` hinzu. Beschwert sich `dotnet ef` anschließend darüber, steht die Lösung in [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/de/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

## Gotchas and lookalike errors

**RID-spezifische .NET-10-Tools verbergen eine bessere Meldung.** .NET 10 erlaubt es Autoren, [plattformspezifische Tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) auszuliefern: ein kleines Root-Paket, dessen `DotnetToolSettings.xml` `Version="2"` verwendet und auf Pakete pro RID verweist. Ich habe eines mit `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` auf SDK 10.0.302 gepackt. SDK 8.0.425 und 9.0.318 lehnten es beide mit dem generischen "was not found"-Text ab, weil das Root-Paket nur einen `net10.0`-Ordner hat. Microsoft hat eine klarere Fehlermeldung nach SDK 8.0.21 zurückportiert ([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414)), Sie erreichen sie aber erst, wenn der Ordner aufgelöst wird. Mit `--framework net10.0` gab SDK 9.0.318 "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." aus. `--framework` kann ein RID-spezifisches Tool nicht retten. Die einzige Lösung ist ein .NET-10-SDK.

**Das Leeren von Caches behebt das nicht.** `dotnet nuget locals all --clear` ist der häufigste Rat zu dieser Meldung. In keinem der drei Fälle oben kann es helfen, denn das Paket wurde korrekt heruntergeladen. Die Datei ist im Paket, nur nicht in einem Ordner, den Ihr SDK auswählt. Ein abgebrochener Download ist theoretisch möglich, steht aber weit hinten auf der Liste. Prüfen Sie `dotnet --version` und den `tools/`-Ordner des Pakets, bevor Sie zum Cache greifen.

**"Tool 'dotnet-ef' is already installed", "is not found in NuGet feeds" und Shim-Konflikte sind andere Fehler** mit anderen Flags. Alle sechs behandelt [every way dotnet tool install --global dotnet-ef fails](/de/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/).

**Die Installation hat funktioniert, aber `dotnet ef` wird "not found".** Das ist ein `PATH`-Problem, kein Paketproblem. Siehe [fixing "dotnet ef" not found](/de/2023/06/how-to-fix-command-dotnet-ef-not-found/).

**Tool-Autoren können ihren Nutzern das ersparen.** Targeten Sie das Tool mehrfach (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` mit `<PackAsTool>true</PackAsTool>`), damit ältere SDKs einen Ordner finden, den sie ausführen können, so wie `dotnet-ef` es ab 10.0.2 macht. Für RID-spezifische Tools beschreibt Andrew Lock einen Kompromiss: ein Root-Paket, das zusätzlich einen Framework-abhängigen Build für alte SDKs enthält. Das SDK-Team stimmt zu, dass die Meldung wenig hilfreich ist. [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) und [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) sind zum Zeitpunkt dieses Beitrags beide noch offen.

## Related

- [Fix: dotnet tool install --global dotnet-ef throws an error](/de/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/), für die anderen Installationsfehler und die Laufzeit-Diskrepanz, die erst nach einer erfolgreichen Installation auffällt.
- [How to fix "dotnet ef" not found](/de/2023/06/how-to-fix-command-dotnet-ef-not-found/), für die `PATH`-Seite desselben Tools.
- [Fix: the command dotnet could not be found on CI](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), dazu, wie CI-Runner ein SDK auswählen und bereitstellen.
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/de/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), für das Paket, das man irrtümlich als Tool installieren will.
- [Migrate from .NET 8 to .NET 11: the full checklist](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), wenn das SDK-Upgrade Teil eines größeren Umstiegs ist.

## Sources

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) und [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs), für die Framework-Auswahl und den `MissingToolSettingsFile`-Throw.
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878), der Bericht zu `AzureSignTool` 7.0.0 und die Erklärung, dass die Regression seit .NET 7 besteht, als Tool-Downloads nicht mehr über Restore liefen.
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414), der 8.0.4xx-Backport der Fehlermeldung "Format version is higher than supported".
- [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) auf Microsoft Learn.
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), für `--framework`, `--tool-path` und das Manifestverhalten.
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/), für die Schemata von `DotnetToolSettings.xml` in Version 1 und Version 2.
