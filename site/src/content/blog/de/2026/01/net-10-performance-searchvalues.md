---
title: ".NET 10 Performance: SearchValues"
description: "Nutzen Sie SearchValues in .NET 10 für leistungsstarke Multi-String-Suche. Ersetzt foreach-Schleifen durch SIMD-beschleunigtes Matching mit den Algorithmen Aho-Corasick und Teddy."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/net-10-performance-searchvalues"
translatedBy: "claude"
translationDate: 2026-05-01
---
In .NET 8 führte Microsoft `SearchValues<T>` ein, einen spezialisierten Typ, der die Suche nach einer _Menge_ von Werten (etwa Bytes oder chars) innerhalb eines Spans optimierte. Er vektorisierte die Suche und machte sie deutlich schneller als `IndexOfAny`.

In .NET 10 wurde diese Leistungsfähigkeit auf Strings erweitert. `SearchValues<string>` ermöglicht es Ihnen, mehrere Teilstrings gleichzeitig mit beeindruckender Performance zu suchen.

## Der Anwendungsfall: Parsing und Filterung

Stellen Sie sich vor, Sie schreiben einen Parser oder einen Sanitizer, der prüfen muss, ob ein Text Wörter oder Tokens aus einer bestimmten Sperrliste enthält.

**Der alte Weg (langsam)**

```cs
private static readonly string[] Forbidden = { "drop", "delete", "truncate" };

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    foreach (var word in Forbidden)
    {
        if (input.Contains(word, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

Das ist O(N \* M), wobei N die Eingabelänge und M die Anzahl der Wörter ist. Der String wird wiederholt durchsucht.

## Der neue Weg: SearchValues

Mit .NET 10 können Sie die Suchstrategie vorab berechnen.

```cs
using System.Buffers;

// 1. Create the optimized searcher (do this once, statically)
private static readonly SearchValues<string> SqlTokens = 
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    // 2. Search for ANY of them in one pass
    return input.ContainsAny(SqlTokens);
}
```

## Auswirkung auf die Leistung

Unter der Haube analysiert `SearchValues.Create` die Muster.

-   Wenn sie gemeinsame Präfixe teilen, baut es eine Trie-ähnliche Struktur auf.
-   Es verwendet Aho-Corasick- oder Teddy-Algorithmen je nach Musterdichte.
-   Es nutzt SIMD (AVX-512), um mehrere Zeichen parallel zu vergleichen.

Bei einer Menge von 10 bis 20 Schlüsselwörtern kann `SearchValues` **50-mal schneller** sein als eine Schleife oder eine Regex.

## Position finden

Sie sind nicht auf eine boolesche Prüfung beschränkt. Sie können herausfinden, _wo_ die Übereinstimmung aufgetreten ist:

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## Zusammenfassung

`SearchValues<string>` in .NET 10 bringt leistungsstarke Textsuche in den Mainstream, ohne externe Bibliotheken zu erfordern. Wenn Sie Textverarbeitung, Log-Analyse oder Sicherheitsfilterung betreiben, ersetzen Sie Ihre `foreach`-Schleifen sofort durch `SearchValues`.
