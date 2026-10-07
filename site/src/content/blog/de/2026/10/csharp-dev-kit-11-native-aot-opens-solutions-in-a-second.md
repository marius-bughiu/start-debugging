---
title: "C# Dev Kit 11.0 fasst sechs Prozesse in einer Native-AOT-Binärdatei zusammen"
description: "Die Pre-Release von C# Dev Kit 11.0 ersetzt sechs verwaltete Prozesse durch einen einzigen Native-AOT-Prozess namens CSDevKit und einen persistenten Projekt-Cache. Eine Aspire-Solution mit 407 Projekten ist nach 3,0 s bereit statt nach 84,1 s und benötigt 316 MB statt 2.072 MB."
pubDate: 2026-10-07
tags:
  - "vscode"
  - "csharp"
  - "dotnet-11"
  - "native-aot"
  - "tooling"
lang: "de"
translationOf: "2026/10/csharp-dev-kit-11-native-aot-opens-solutions-in-a-second"
translatedBy: "claude"
translationDate: 2026-10-07
---

Am 6. Oktober 2026 hat Drew Noakes im .NET Blog den Beitrag [A faster, lighter C# Dev Kit](https://devblogs.microsoft.com/dotnet/faster-lighter-csharp-dev-kit/) veröffentlicht. C# Dev Kit springt von Version 3.3 auf 11.0, die Nummerierung folgt damit nun .NET 11. Die neue Nummer geht mit einem Umbau einher, wie die Erweiterung Solutions in VS Code lädt. Wenn Sie VS Code für große C#-Solutions aufgegeben haben, weil der Spinner "Loading projects..." nie zu enden schien, sollten Sie es noch einmal versuchen.

## Aus sechs verwalteten Prozessen wurde eine Native-AOT-Binärdatei

C# Dev Kit 3.x startete sechs getrennte verwaltete Prozesse. Jeder startete die Laufzeit und kompilierte seinen eigenen Startcode per JIT, bevor er arbeiten konnte. Version 11.0 führt sie in einem einzigen, mit Native AOT kompilierten Prozess `CSDevKit` zusammen, sodass dieser Startpfad weder eine Laufzeit lädt noch den JIT ausführt.

Der C#-Sprachdienst (Roslyn) läuft weiterhin in einem eigenen Prozess, daher gelten die folgenden Speicherwerte nur für die Dev-Kit-Seite. Der Rückgang ist trotzdem erheblich:

| Solution | Projekte | C#-Dateien | 3.3 | 11.0 |
|----------|----------|----------|-----|------|
| Orleans | 155 | 4.010 | 1.307 MB | 208 MB |
| Roslyn | 398 | 18.153 | 2.000 MB | 379 MB |
| Aspire | 407 | 4.686 | 2.072 MB | 316 MB |

Das sind bei allen drei Repositories etwa 81-85 % weniger Speicher.

## Ein Projekt-Cache, den Sie einchecken können

Die andere Hälfte der Beschleunigung ist ein persistenter Projekt-Cache. Beim ersten Laden werden Ihre Projekte ausgewertet und die Ergebnisse gespeichert. Spätere Starts lesen aus dem Cache und überspringen die vollständige Design-Time-Auswertung. Im Aspire-Repository ist die aktive Datei nach 0,47 s nutzbar statt nach 84,1 s, und die gesamte Solution ist nach 3,0 s bereit. Orleans braucht 0,53 s für die aktive Datei und 2,3 s für die gesamte Solution, zuvor waren es 50,3 s.

Der Blogbeitrag nennt außerdem: Wenn Sie die Cache-Dateien in die Versionsverwaltung einchecken, erhalten frische Klone und neue Git-Worktrees sofort schnelles Tooling. Das ist relevant, wenn Sie mehrere Git-Worktrees parallel betreiben, zum Beispiel für parallel arbeitende Coding-Agenten. Heute kostet jeder neue Worktree ein weiteres kaltes Laden der Projekte. Die Ankündigung nennt weder die Namen der Cache-Dateien noch, was den Cache ungültig macht. Prüfen Sie daher, was die Erweiterung in Ihr Repository schreibt, bevor Sie Ihre `.gitignore` ändern.

Auch inkrementelle Builds wurden schneller. Ein Build ohne Änderungen dauert bei der Aspire-Solution 0,88 s statt 34,4 s, und ein Build nach der Änderung einer Datei 2,1 s statt 36,1 s.

## MSBuild-Dateien erhalten echtes IntelliSense

Version 11.0 bringt außerdem Sprachunterstützung für `.csproj`-, `.props`- und `.targets`-Dateien: Vervollständigungen, Diagnosen, Gehe zu Definition, Quick Fixes und semantische Hervorhebung. Paketnamen und Versionen werden während der Eingabe vervollständigt, und CodeLens zeigt über Paketen mit bekannten Sicherheitslücken eine Warnung an:

```xml
<ItemGroup>
  <!-- package id and version now complete; vulnerable versions get a CodeLens warning -->
  <PackageReference Include="MessagePack" Version="3.1.11" />
</ItemGroup>
```

Eine neue Ansicht "C# Doctor" bündelt Prüfungen zu SDK, Laufzeit, Zielframework, Wiederherstellung und Sicherheitslücken an einem Ort. Sie müssen nicht mehr durch die Ausgabekanäle suchen, um herauszufinden, warum ein Projekt nicht geladen wurde.

## Die Pre-Release ausprobieren

Version 11.0 ist noch eine Pre-Release. Öffnen Sie in der Ansicht "Extensions" C# Dev Kit und wählen Sie **Switch to Pre-Release Version**. Alternativ geht es auch über ein Terminal:

```bash
code --install-extension ms-dotnettools.csdevkit --pre-release
```

Um die Speicherwerte an Ihrer eigenen Solution zu prüfen, suchen Sie nach dem Laden der Solution den zusammengeführten Prozess:

```bash
# macOS / Linux: resident memory in KB
ps -A -o rss,comm | grep -i csdevkit
```

Melden Sie Fehler unter [microsoft/vscode-dotnettools](https://github.com/microsoft/vscode-dotnettools). Ein Umbau dieser Größe wird bei manchen Projektstrukturen Ecken und Kanten haben, und das Team sammelt diese Meldungen vor dem stabilen Release.
