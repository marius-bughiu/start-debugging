---
title: ".NET 8 Performance: UnsafeAccessor vs. Reflection"
description: "Reproduzierbarer .NET-8-Benchmark: UnsafeAccessor, Reflection, gecachte Reflection, gecachte Delegaten und direkte Aufrufe mit beobachtbarer Arbeit vergleichen."
pubDate: 2023-11-01
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ein `UnsafeAccessor` bindet an einen bekannten Member ohne Reflection-Suche oder `MethodInfo.Invoke`. Ein sinnvoller Vergleich muss beobachtbare Zielarbeit enthalten und erklären, was die einzelnen Aufrufwege tun.

**Korrektur — 2. November 2026:** Das alte Quellcode-Repository ist nicht verfügbar. Das Beispiel wurde mit Funktionsprüfung, Allokationsdiagnostik, gecachten Delegaten und passenden, nicht inline ausgeführten Zielmethoden wiederhergestellt. Die früheren Zeiten nahe null belegen keinen universell fehlenden Overhead und werden nicht mehr als reproduzierbare Messungen dargestellt.

## Herunterladen und ausführen

[Benchmark-Quellcode herunterladen](/examples/unsafe-accessor-benchmarks.zip). Das Projekt zielt auf .NET 8 und verwendet fest BenchmarkDotNet 0.15.8.

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

Der erste Befehl prüft, dass alle fünf Aufrufwege für Eingabe `42` den Wert `59` liefern. Der zweite ist eine Ausführungsprüfung mit einer Iteration. Nutze den letzten Befehl für reguläre Messungen und bewahre erzeugte Umgebungs- und Berichtsdateien auf, bevor du Zeiten interpretierst.

## Was verglichen wird

1. **Direkter Aufruf:** ruft eine öffentliche Methode auf.
2. **UnsafeAccessor:** bindet an eine private Methode mit derselben Operation.
3. **Reflection-Suche und Aufruf:** sucht die Methode und ruft sie bei jeder Operation auf.
4. **Gecachte Reflection:** verwendet `MethodInfo` erneut, übergibt aber weiterhin ein Objektarray als Argumentliste.
5. **Gecachter Delegat:** verwendet einen offenen Instanzdelegaten für die private Methode erneut.

Beide Zielmethoden addieren zum Eingabewert ein Instanzfeld und verwenden `MethodImplOptions.NoInlining`. Jeder Benchmark gibt das Ergebnis zurück. Die Eingabe ist ein BenchmarkDotNet-Parameter, damit die Demonstration nicht zu einer inline ausgeführten Methode mit konstanter Rückgabe schrumpft.

`MemoryDiagnoser` erfasst Allokationen einschließlich Argumentarray und Boxing in den Reflection-Fällen. Die Wege leisten unterschiedliche Arbeit; Zeitunterschiede sind nicht allein eine Zugriffskontrolle.

## Prüfung und Interpretation

Das wiederhergestellte Projekt wurde mit .NET 8.0.33 auf macOS arm64 ausgeführt. Die Funktionsprüfung und alle fünf BenchmarkDotNet-Dry-Jobs bestanden. Dry-Zeiten werden bewusst nicht als Leistungstabelle veröffentlicht: Sie prüfen den Messaufbau, liefern aber keine stabilen Nanosekundenwerte.

Inlining, Laufzeitversion, Architektur, Zielarbeit, Caching und Allokationen beeinflussen das Ergebnis. Ein winziger Messwert kann bedeuten, dass der JIT Arbeit entfernt hat oder die Messung unterhalb der brauchbaren Auflösung des Aufbaus liegt. Er beweist nicht, dass jeder Accessor-Aufruf kostenlos ist.

Ein Accessor benötigt zudem die Signatur zur Kompilierzeit. Reflection bleibt nützlich, wenn Typ oder Member erst zur Laufzeit gefunden werden. Die [Member-Beispiele](/de/2023/10/unsafe-accessor/) und [Microsofts API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) erklären diesen Unterschied.
