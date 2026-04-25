---
title: "Rider 2026.1 liefert einen ASM-Viewer für JIT-, ReadyToRun- und NativeAOT-Ausgabe"
description: "Rider 2026.1 fügt ein .NET Disassembler Plugin hinzu, mit dem Sie den vom JIT-, ReadyToRun- und NativeAOT-Compiler erzeugten Maschinencode inspizieren können, ohne die IDE zu verlassen."
pubDate: 2026-04-13
tags:
  - "rider"
  - "jetbrains"
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "de"
translationOf: "2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly"
translatedBy: "claude"
translationDate: 2026-04-25
---

JetBrains hat [Rider 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/rider-2026-1-released/) am 30. März veröffentlicht, und die Schlagzeilen-Ergänzung im Developer-Tooling ist ein neuer ASM-Viewer, der das native Disassembly Ihres C#-Codes direkt in der IDE rendert. Das Plugin unterstützt JIT-, ReadyToRun (crossgen2)- und NativeAOT (ilc)-Ausgabe auf x86/x64 und ARM64.

## Warum überhaupt Assembly anschauen

Performance-sensitiver .NET-Code, denken Sie an heiße Schleifen, SIMD-Pfade oder struct-lastige Allokationen, verhält sich manchmal anders, als die C#-Quelle vermuten lässt. Der JIT könnte einen Aufruf devirtualisieren, die PGO-Daten könnten eine Methode inlinen, von der Sie erwartet hatten, dass sie ein Aufruf bleibt, oder NativeAOT könnte Structs auf eine Weise anordnen, die Ihre Cache-Line-Annahmen zerstört. Bisher brauchten Sie externe Werkzeuge wie [SharpLab](https://sharplab.io), den `DisassemblyDiagnoser` von BenchmarkDotNet oder Egor Bogatovs [Disasmo](https://github.com/EgorBo/Disasmo), um zu sehen, was tatsächlich auf der CPU landet. Rider 2026.1 bringt diesen Workflow in den Editor.

## Einstieg

Installieren Sie das Plugin über **Settings > Plugins > Marketplace**, indem Sie nach ".NET Disassembler" suchen. Es erfordert ein .NET 6.0+ Projekt. Nach der Installation öffnen Sie eine beliebige C#-Datei, setzen den Cursor auf eine Methode oder Eigenschaft und öffnen **View > Tool Windows > ASM Viewer** (oder Rechtsklick und Auswahl aus dem Kontextmenü). Rider kompiliert das Ziel und zeigt die Assembly-Ausgabe automatisch an.

Nehmen Sie ein einfaches Beispiel:

```csharp
public static int Sum(int[] values)
{
    int total = 0;
    for (int i = 0; i < values.Length; i++)
        total += values[i];
    return total;
}
```

Mit aktiviertem PGO und aktiver Tiered Compilation wird der JIT auf .NET 10 diese Schleife zu SIMD-Befehlen vektorisieren. Der ASM-Viewer zeigt Ihnen die `vpaddd`- und `vmovdqu`-Befehle, die beweisen, dass das tatsächlich passiert ist, direkt neben Ihrer Quelle.

## Snapshot und Diff

Das Plugin unterstützt Snapshots. Sie können die aktuelle Assembly-Ausgabe erfassen, eine Codeänderung vornehmen und dann beide nebeneinander vergleichen. Das ist nützlich, wenn Sie überprüfen wollen, dass ein kleines Refactoring (etwa der Wechsel von `Span<T>` zu `ReadOnlySpan<T>` oder das Hinzufügen eines `[MethodImpl(MethodImplOptions.AggressiveInlining)]`-Attributs) den generierten Code tatsächlich so ändert, wie Sie es erwarten.

## Konfigurationsoptionen

Die Toolbar im ASM-Viewer erlaubt das Umschalten von:

- **Tiered Compilation** ein oder aus
- **PGO** (Profile-Guided Optimization)
- **Diff-freundliche Ausgabe**, die Adressen für saubere Vergleiche stabilisiert
- Compiler-Ziel: JIT, ReadyToRun oder NativeAOT

Zwischen JIT- und NativeAOT-Ausgabe für dieselbe Methode zu wechseln ist eine schnelle Möglichkeit zu sehen, wie stark die beiden Pipelines für Ihre spezifischen Code-Muster divergieren.

## Wo das hineinpasst

Der ASM-Viewer ersetzt BenchmarkDotNet nicht beim Messen von tatsächlichem Durchsatz. Er ergänzt es. Wenn ein Benchmark eine unerwartete Regression zeigt, gibt Ihnen der Viewer einen schnellen Pfad zu "was hat sich am generierten Code geändert?" ohne Werkzeugwechsel oder das Schreiben eines separaten Test-Harness. Das Plugin basiert auf dem [Disasmo-Projekt](https://github.com/EgorBo/Disasmo) von Egor Bogatov und ist auf Windows, macOS und Linux verfügbar. Vollständige Details auf dem [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/29736--net-disassembler).
