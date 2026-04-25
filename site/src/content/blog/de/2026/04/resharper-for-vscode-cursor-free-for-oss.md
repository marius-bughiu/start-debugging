---
title: "ReSharper landet in VS Code und Cursor, kostenlos für nicht-kommerzielle Nutzung"
description: "JetBrains hat ReSharper als VS Code-Erweiterung mit vollständiger C#-Analyse, Refactoring und Unit-Tests veröffentlicht. Funktioniert auch in Cursor und Google Antigravity und kostet nichts für OSS und Lernen."
pubDate: 2026-04-12
tags:
  - "resharper"
  - "vs-code"
  - "csharp"
  - "tooling"
lang: "de"
translationOf: "2026/04/resharper-for-vscode-cursor-free-for-oss"
translatedBy: "claude"
translationDate: 2026-04-25
---

Jahrelang bedeutete ReSharper eines: eine Visual Studio-Erweiterung. Wenn Sie C#-Analyse auf JetBrains-Niveau außerhalb von Visual Studio wollten, war Rider die Antwort. Das änderte sich am 5. März 2026, als JetBrains [ReSharper für Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/), Cursor und Google Antigravity veröffentlicht hat. Die [Version 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) am 30. März folgte mit Performance-Monitoring und engerer Integration.

## Was Sie bekommen

Die Erweiterung bringt das zentrale ReSharper-Erlebnis in jeden Editor, der die VS Code-Erweiterungs-API spricht:

- **Codeanalyse** für C#, XAML, Razor und Blazor mit derselben Inspektionsdatenbank, die ReSharper in Visual Studio verwendet
- **Lösungsweites Refactoring**: Umbenennen, Methode extrahieren, Typ verschieben, Variable inlinen, und der Rest des Katalogs
- **Navigation** einschließlich Gehe-zur-Definition in dekompilierten Quellcode
- **Ein Solution Explorer**, der Projekte, NuGet-Pakete und Source Generators handhabt
- **Unit-Tests** für NUnit, xUnit.net und MSTest mit Inline-Run-/Debug-Steuerelementen

Nachdem Sie die Erweiterung installiert und einen Ordner geöffnet haben, erkennt ReSharper `.sln`-, `.slnx`-, `.slnf`- oder eigenständige `.csproj`-Dateien automatisch. Keine manuelle Konfiguration nötig.

## Der Lizenz-Aspekt

JetBrains hat das für nicht-kommerzielle Nutzung kostenlos gemacht. Das umfasst Open-Source-Beiträge, Lernen, Content-Erstellung und Hobby-Projekte. Kommerzielle Teams brauchen eine ReSharper- oder dotUltimate-Lizenz, dieselbe, die die Visual Studio-Erweiterung abdeckt.

## Ein schneller Probelauf

Installieren Sie aus dem VS Code Marketplace, dann öffnen Sie eine beliebige C#-Lösung:

```bash
code my-project/
```

ReSharper indiziert die Lösung und beginnt sofort, Inspektionen einzublenden. Probieren Sie die Command Palette (`Ctrl+Shift+P`) und tippen Sie "ReSharper", um verfügbare Aktionen zu sehen, oder rechtsklicken Sie ein beliebiges Symbol für das Refactoring-Menü.

Eine schnelle Methode zu prüfen, ob es funktioniert:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

Wenn Sie den Vorschlag sehen, zu `["a", "b", "c"]` zu konvertieren, läuft die Analyse-Engine.

## Für wen das ist

Cursor-Nutzer, die C# schreiben, bekommen nun erstklassige Analyse, ohne ihren KI-nativen Editor zu verlassen. VS Code-Nutzer, die Rider wegen Kosten oder Vorlieben gemieden haben, bekommen dieselbe Inspektionstiefe, die ReSharper Visual Studio-Nutzern zwei Jahrzehnte lang geboten hat. Und OSS-Maintainer bekommen es kostenlos.

Der [vollständige Ankündigungsbeitrag](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) deckt Installationsdetails und bekannte Einschränkungen ab.
