---
title: "C#: Ein readonly-Feld mit UnsafeAccessor ändern"
description: "Ein lauffähiges .NET-8-Beispiel für ein per UnsafeAccessor erreichbares readonly-Feld, mit klaren Grenzen der Mutation und beobachtetem Laufzeitverhalten."
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ein UnsafeAccessor in .NET 8 kann ein Instanzfeld als Referenz bereitstellen, auch wenn es als `readonly` deklariert ist. Schreiben über diese Referenz umgeht die normalen C#-Zuweisungsregeln. Es ändert weder die Deklaration noch garantiert es einheitliches Verhalten bei optimierten Lesezugriffen auf unveränderlichen Zustand.

**Korrektur — 2. November 2026:** Das nicht mehr verfügbare Beispiel wurde wiederhergestellt. Die pauschale Leistungsbehauptung und das uneingeschränkte Ergebnis eines direkten Lesezugriffs wurden entfernt; das geprüfte Beispiel beobachtet den Wert über den Accessor.

## Lauffähiges Beispiel

[Vollständiges Beispiel herunterladen](/examples/unsafe-accessor.zip). Es enthält Zugriffe auf private Member sowie diesen gezielten readonly-Fall:

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

Starte das heruntergeladene Projekt mit `dotnet run -c Release`. Das vollständige Beispiel prüft unter .NET 8.0.33 den Anfangswert, führt den Schreibzugriff aus und prüft das Ergebnis über den Accessor.

## Was damit nachgewiesen ist

Die Signatur passt zu deklarierendem Typ, Name und Typ des Felds. Die Rückgabe `ref int` erlaubt die gezeigte Zuweisung. Daraus folgt nicht, dass Schreibzugriffe über andere Referenzen, nebenläufige Änderungen oder jede JIT-/AOT-Optimierung gleich reagieren. Ein direkter Lesezugriff an anderer Stelle ist keine allgemeine Garantie für unterstützte Mutation.

Für Anwendungszustand sind Konstruktorinitialisierung oder eine ausdrücklich veränderliche API vorzuziehen. Reflection-Schreibzugriffe auf Instanzfelder und statische readonly-Felder unterliegen außerdem unterschiedlichen Laufzeitbeschränkungen; sie sind nicht austauschbar.

Die [Member-Anleitung](/de/2023/10/unsafe-accessor/) zeigt normale Accessoren, das [Benchmark-Projekt](/de/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) einen messbaren Vergleich von Aufrufwegen. Die [offizielle API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) beschreibt Signaturen und Versionsgrenzen.
