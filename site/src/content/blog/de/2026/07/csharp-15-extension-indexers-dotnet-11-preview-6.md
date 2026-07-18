---
title: "C# 15 Extension-Indexer vervollständigen die Extension-Member in .NET 11 Preview 6"
description: "Extension-Indexer sind in .NET 11 Preview 6 eingetroffen und erlauben es, Typen, die Sie nicht kontrollieren, um this[...]-Zugriff zu erweitern. Sie vervollständigen die Geschichte der Extension-Member, die mit Methoden und Eigenschaften in C# 14 begann."
pubDate: 2026-07-18
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "extension-members"
lang: "de"
translationOf: "2026/07/csharp-15-extension-indexers-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-18
---

.NET 11 Preview 6 erschien am 2026-07-14, und versteckt im C#-Abschnitt der Release Notes findet sich das Stück, das die Extension-Member endlich vollständig wirken lässt: die Extension-Indexer. Extension-Methoden gibt es seit C# 3.0, Extension-Eigenschaften kamen mit dem [Extension-Block in C# 14](/de/2026/06/how-to-declare-extension-properties-in-csharp-14/), und jetzt können Sie einem Typ, den Sie nicht kontrollieren, `this[...]`-Zugriff hinzufügen.

## Was bisher fehlte

Der naheliegende Behelf war schon immer eine einfache Extension-Methode. Wenn Sie eine Index-von-hinten-Semantik auf einer `IReadOnlyList<T>` wollten, die keinen Indexer mitbringt, der `Index` versteht, schrieben Sie etwa Folgendes:

```csharp
public static class ReadOnlyListExtensions
{
    public static T At<T>(this IReadOnlyList<T> list, Index index)
        => list[index.GetOffset(list.Count)];
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log.At(^1));   // done
Console.WriteLine(log.At(^2));   // work
```

Das funktioniert, aber die Aufrufstelle liest sich als `log.At(^1)` statt der `log[^1]`-Syntax, die jeder andere listenartige Typ bietet. Sie verlieren die eckige-Klammer-Notation, und Sie verlieren sie auch in Listenmustern.

## Die Variante mit Extension-Indexer

C# 15 erlaubt es, den Indexer innerhalb eines `extension`-Blocks zu deklarieren, genau so, wie Sie einen Instanz-Indexer deklarieren würden:

```csharp
public static class ReadOnlyListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public T this[Index index] => list[index.GetOffset(list.Count)];
    }
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log[^1]);   // done
Console.WriteLine(log[^2]);   // work
```

Der vom Kopf `extension<T>(IReadOnlyList<T> list)` erfasste Empfänger ist im Rumpf im Gültigkeitsbereich, sodass der Indexer direkt an `list` weiterleitet. Die Aufrufstelle verwendet nun echte Indexer-Syntax, und weil der Compiler sie als Indexer behandelt, nimmt sie an Listenmustern und Bereichsausdrücken genauso teil wie ein eingebauter Indexer.

Extension-Indexer sind nicht auf die Form mit einem einzigen Parameter und nur Lesezugriff beschränkt. Sie unterstützen mehrere Parameter sowie die `get`- und `set`-Accessoren, sodass Sie eine zweidimensionale Suche auf einen flachen Speicher projizieren oder eine Schreibansicht auf einen Typ freilegen können, der nur methodenbasierten Zugriff bietet.

## Aktivierung

Dies ist weiterhin ein Sprachfeature in der Vorschau, daher wird es in der Standard-Sprachversion nicht aktiviert. Fügen Sie Folgendes zu Ihrer `.csproj` hinzu:

```xml
<LangVersion>preview</LangVersion>
```

Extension-Indexer sind der letzte der drei klassischen Member-Typen, der in den Extension-Blöcken ankommt, was bedeutet, dass das mentale Modell nun einheitlich ist: Methoden, Eigenschaften und Indexer werden innerhalb von `extension(...)` auf dieselbe Weise deklariert. Wenn Sie bisher zu Wrapper-Typen oder umständlichen `.At()`-Hilfsmethoden gegriffen haben, um einen fehlenden Indexer zu überbrücken, ist Preview 6 die Version, mit der Sie sie löschen können. Die vollständige Beschreibung finden Sie im [C#-Abschnitt der Preview-6-Release-Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/csharp.md).
