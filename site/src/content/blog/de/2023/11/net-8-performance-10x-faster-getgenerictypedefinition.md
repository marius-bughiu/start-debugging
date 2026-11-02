---
title: "GetGenericTypeDefinition in .NET 8: ein reproduzierbarer Benchmark"
description: "Wiederholte GetGenericTypeDefinition-Aufrufe mit BenchmarkDotNet reproduzieren und ausgewählte .NET-Laufzeiten ohne festen Beschleunigungsfaktor vergleichen."
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
Microsoft dokumentierte Verbesserungen an generischen Typinformationen in .NET 8, darunter das Cachen des Ergebnisses von `GetGenericTypeDefinition` im `Type`-Objekt. Das ist eine konkrete Laufzeitoptimierung, kein fester Faktor für jede Reflection-Aufgabe.

**Korrektur — 2. November 2026:** Der frühere „10x“-Titel und die nicht zugeordneten Messwerte wurden entfernt, weil die ursprünglichen Laufartefakte und das Repository fehlen. Die historische URL bleibt erhalten; ein lauffähiger Benchmark wird jetzt mit dieser Website gepflegt.

## Den Benchmark wiederherstellen

[Quellprojekt herunterladen](/examples/generic-type-definition-benchmarks.zip). Es wird für .NET 7 und .NET 8 gebaut und verwendet fest BenchmarkDotNet 0.13.12. Die zentrale Operation ist:

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

Das vollständige Projekt enthält Imports und Runner. Starte Funktionsprüfung und normale Messungen:

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

Die Funktionsprüfung erwartet `typeof(List<>)` als Ergebnis. Ein Dry-Job kann die Ausführung schnell prüfen, seine Zeit ist jedoch kein verlässliches Leistungsergebnis.

## .NET 7 und .NET 8 vergleichen

Installiere beide Laufzeiten und wähle sie ausdrücklich aus:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

Der historische Vergleich benötigt genau diese Laufzeiten. Eine auf .NET 8 zielende Anwendung unter einer neueren Laufzeit reproduziert keine .NET-8-Messung. Bewahre die erzeugten Umgebungsdetails und Berichte mit jedem veröffentlichten Ergebnis auf.

Dieser Benchmark misst wiederholte Aufrufe für einen bekannten `Type`. Er misst weder das Laden von Typen noch ungecachte Suche oder eine ganze Anwendung. Microsofts [.NET-8-Leistungsanalyse](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/) erklärt die Optimierung und berichtet eigene Messungen; diese sind von der Prüfung dieses Projekts zu unterscheiden.

Eine andere Reflection-Aufgabe behandelt der [UnsafeAccessor-Vergleich](/de/2023/11/net-8-performance-unsafeaccessor-vs-reflection/).
