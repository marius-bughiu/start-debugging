---
title: "Häufigkeitszählung mit LINQ CountBy optimieren"
description: "Ersetzen Sie GroupBy durch CountBy in .NET 9, um Häufigkeiten sauberer und effizienter zu zählen. Reduziert Allokationen von O(N) auf O(K), indem zwischenliegende Gruppierungsstrukturen übersprungen werden."
pubDate: 2026-01-01
tags:
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/optimizing-frequency-counting-with-linq-countby"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eine der häufigsten Operationen in der Datenverarbeitung ist das Berechnen der Häufigkeit von Elementen in einer Sammlung. Über Jahre haben sich C#-Entwickler dafür auf das `GroupBy`-Muster verlassen. Funktional, aber oft mit unnötigem Overhead verbunden, da Bucket-Objekte für Gruppen allokiert werden, die direkt nach dem Zählen wieder verworfen werden.

Mit .NET 9 führt der Namespace System.Linq `CountBy` ein, eine spezialisierte Methode, die diese Operation deutlich vereinfacht.

## Der Overhead von früher

Vor .NET 9 erforderte das Zählen von Vorkommen üblicherweise eine umfangreiche Kette von LINQ-Aufrufen. Sie mussten die Elemente gruppieren und dann in einen neuen Typ projizieren, der den Schlüssel und die Anzahl enthält.

```cs
// Before: Verbose and allocates group buckets
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

var frequency = logLevels
    .GroupBy(level => level)
    .Select(group => new { Level = group.Key, Count = group.Count() })
    .ToDictionary(x => x.Level, x => x.Count);
```

Dieser Ansatz funktioniert, ist aber schwer. Der `GroupBy`-Iterator baut interne Datenstrukturen auf, um die Elemente jeder Gruppe zu halten, obwohl uns nur die Anzahl interessiert. Bei großen Datenmengen erzeugt das unnötigen Druck auf die Garbage Collection.

## Vereinfachung mit CountBy

.NET 9 fügt `CountBy` direkt zu `IEnumerable<T>` hinzu. Diese Methode liefert eine Auflistung von `KeyValuePair<TKey, int>` und entzieht damit Zwischengruppierungsstrukturen die Notwendigkeit.

```cs
// After: Clean, intent-revealing, and efficient
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

foreach (var (level, count) in logLevels.CountBy(level => level))
{
    Console.WriteLine($"{level}: {count}");
}
```

Die Syntax ist nicht nur sauberer, sie erklärt auch ausdrücklich die Absicht: Wir zählen nach einem Schlüssel.

## Auswirkungen auf die Leistung

Unter der Haube ist `CountBy` so optimiert, dass es die von `GroupBy` benötigten Gruppierungs-Buckets nicht allokiert. In einem klassischen `GroupBy`-Szenario erzeugt die Laufzeit oft pro eindeutigem Schlüssel ein `Grouping<TKey, TElement>`-Objekt und führt intern eine Sammlung der Elemente für diesen Schlüssel. Bei 1 Million Elementen und 100 eindeutigen Schlüsseln kann `GroupBy` weiterhin erheblichen Aufwand betreiben, um diese 1 Million Elemente in Listen zu organisieren.

`CountBy` hingegen muss nur den Zähler verfolgen. Es verhält sich praktisch wie ein `Dictionary<TKey, int>`-Akkumulator. Es iteriert die Quelle einmal, erhöht den Zähler für den Schlüssel und verwirft das Element. Dadurch wird aus einer O(N)-Operation im Speicher (was das Halten von Elementen angeht) etwas, das näher bei O(K) liegt, wobei K die Anzahl der eindeutigen Schlüssel ist.

In Szenarien mit hohem Durchsatz, etwa bei der Analyse von Server-Logs, der Verarbeitung von Transaktionsströmen oder der Aggregation von Sensordaten, ist dieser Unterschied nicht trivial. Er reduziert den GC-Druck, weil die schweren "Bucket"-Objekte direkt verworfen werden.

### Sonderfälle und Schlüssel

Wie `GroupBy` verlässt sich auch `CountBy` auf den Standard-Equality-Comparer des Schlüsseltyps, sofern nichts anderes angegeben ist. Wenn Sie nach einem benutzerdefinierten Objektschlüssel zählen, stellen Sie sicher, dass `GetHashCode` und `Equals` korrekt überschrieben sind, oder geben Sie einen eigenen `IEqualityComparer<TKey>` an.

```cs
// Handling case-insensitivity explicitly
var frequency = logLevels.CountBy(level => level, StringComparer.OrdinalIgnoreCase);
```

### Wann man bei GroupBy bleibt

Es ist erwähnenswert, dass `CountBy` strikt für das Zählen gedacht ist. Wenn Sie die tatsächlichen Elemente brauchen (z. B. "gib mir die ersten 5 Fehler"), benötigen Sie weiterhin `GroupBy`. Aber für Histogramme, Häufigkeitskarten und Analytics ist `CountBy` in .NET 9 das überlegene Werkzeug.

Mit `CountBy` reduzieren Sie Wortreichtum und verbessern die Allokationsmuster in Ihren LINQ-Pipelines. Damit wird es zur Standardwahl für Häufigkeitsanalysen in modernen C#-Codebasen.
