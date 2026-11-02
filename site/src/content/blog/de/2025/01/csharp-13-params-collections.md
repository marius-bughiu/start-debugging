---
title: "C# 13: params-Collections mit jedem erkannten Sammlungstyp verwenden"
description: "C# 13 erweitert params auf erkannte Sammlungstypen. Elemente, normale und erweiterte Aufrufe, Voraussetzungen und Allokationen verstehen."
pubDate: 2025-01-02
updatedDate: 2026-11-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---

C# 13 erweitert `params` über eindimensionale Arrays hinaus auf erkannte Sammlungstypen. Die erweiterte Aufrufform übergibt einzelne **Elemente**, nicht eine variable Anzahl von Spans.

**Korrektur — 2. November 2026:** Die Erklärung zu Elementen und Anforderungen an Sammlungen wurde berichtigt. Eine Liste ließ sich schon vor C# 13 an einen gewöhnlichen `IEnumerable<T>`-Parameter übergeben. Beide Beispiele wurden mit SDK 10.0.302 und `LangVersion` 13 geprüft.

## Span-Parameter

```csharp
using System;

Print(1, 2, 3); // Expanded form: three int elements.
int[] data = { 4, 5 };
Print(data);    // Normal form: an existing buffer.

static void Print(params ReadOnlySpan<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

Die normale Form übergibt einen vorhandenen, zum Parametertyp konvertierbaren Wert. Die erweiterte Form liefert Elemente, aus denen der Compiler die Sammlung erzeugt. `ReadOnlySpan<T>` kann bei geeigneten Aufrufen ein Array vermeiden, garantiert aber nicht für jeden Typ und Aufruf Allokationsfreiheit.

## Geeignete Sammlungstypen

Unterstützt werden `Span<T>`, `ReadOnlySpan<T>`, die erkannten generischen Sammlungsschnittstellen und mit Collection Expressions kompatible Builder-Typen. Konstruierbare Sammlungen benötigen den erforderlichen zugänglichen parameterlosen Konstruktor, eine passende Instanzmethode `Add` und Enumerationsunterstützung. `IEnumerable<T>` und irgendeine Methode namens `Add` allein reichen nicht.

Zu den Schnittstellen gehören `IEnumerable<T>`, `IReadOnlyCollection<T>`, `IReadOnlyList<T>`, `ICollection<T>` und `IList<T>`.

```csharp
using System;
using System.Collections.Generic;

var values = new List<int> { 1, 2, 3 };
Print(values);  // Normal form.
Print(4, 5, 6); // Expanded form: enabled by params collections in C# 13.

static void Print(params IEnumerable<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

Der erste Aufruf war auch früher mit einem normalen `IEnumerable<int>`-Parameter ohne `params` möglich. Neu ist die erweiterte Form `Print(4, 5, 6)` für diesen Typ. Die dafür erzeugte Sammlung kann Speicher allokieren.

`params` muss zuletzt stehen, darf keinen Standardwert haben und nicht mit `ref`, `in` oder `out` kombiniert werden. Neue params-Sammlungsüberladungen können bei erneuter Kompilierung die Überladungsauflösung ändern. Prüfen Sie die konkreten Aufrufe.

Zum Unterschied zwischen Besitz und Sicht siehe [List, Span und ReadOnlySpan](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Quellen

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
