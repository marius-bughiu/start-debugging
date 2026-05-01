---
title: "C# 13: params-Collections mit jedem erkannten Sammlungstyp verwenden"
description: "C# 13 erweitert den params-Modifier über Arrays hinaus, um Span, ReadOnlySpan, IEnumerable und andere Sammlungstypen zu unterstützen, was Boilerplate reduziert und die Flexibilität erhöht."
pubDate: 2025-01-02
updatedDate: 2025-01-07
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
Der `params`-Modifier in C# wurde traditionell mit Array-Typen in Verbindung gebracht und erlaubt Methoden, eine variable Anzahl von Argumenten zu akzeptieren. [Ab C# 13](/de/2025/01/how-to-switch-to-c-13/) können Sie params-Collections jedoch mit einer Vielzahl von Sammlungstypen verwenden, was die Anwendbarkeit erweitert und Ihren Code noch vielseitiger macht.

## Unterstützte Sammlungstypen

Der `params`-Modifier funktioniert nun mit mehreren erkannten Sammlungstypen, darunter:

-   `System.Span<T>`
-   `System.ReadOnlySpan<T>`
-   Typen, die `System.Collections.Generic.IEnumerable<T>` implementieren und zusätzlich eine `Add`-Methode haben.

Zusätzlich können Sie `params` mit den folgenden System-Interfaces verwenden:

-   `System.Collections.Generic.IEnumerable<T>`
-   `System.Collections.Generic.IReadOnlyCollection<T>`
-   `System.Collections.Generic.IReadOnlyList<T>`
-   `System.Collections.Generic.ICollection<T>`
-   `System.Collections.Generic.IList<T>`

## Ein praktisches Beispiel: Spans mit `params` verwenden

Eine der spannenden Möglichkeiten dieser Verbesserung ist die Fähigkeit, Spans als `params`-Parameter zu verwenden. Hier ist ein Beispiel:

```cs
public void Concat<T>(params ReadOnlySpan<T> items)
{
    for (int i = 0; i < items.Length; i++)
    {
        Console.Write(items[i]);
        Console.Write(" ");
    }

    Console.WriteLine();
}
```

In dieser Methode ermöglicht `params`, eine variable Anzahl von Spans an die `Concat`-Methode zu übergeben. Die Methode verarbeitet jeden Span der Reihe nach und zeigt die erweiterte Flexibilität des `params`-Modifiers.

## Vergleich mit C# 12.0

In früheren C#-Versionen unterstützte das `params`-Schlüsselwort nur Arrays, sodass Entwickler andere Sammlungstypen manuell in Arrays umwandeln mussten, bevor sie an eine Methode mit `params` übergeben werden konnten. Dieser Prozess fügte unnötigen Boilerplate-Code hinzu, etwa das Erzeugen temporärer Arrays oder explizites Aufrufen von Konvertierungsmethoden.

**Beispiel ohne die neue Funktion (vor C# 13)**

```cs
void PrintValues(params int[] values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// Manual conversion to array
PrintValues(list.ToArray());
```

**Beispiel mit der neuen Funktion (C# 13)**

```cs
void PrintValues(params IEnumerable<int> values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// No conversion needed
PrintValues(list);
```

Die neue Funktion reduziert Boilerplate durch:

1.  **Wegfall der manuellen Konvertierung** – keine Notwendigkeit, Sammlungen wie `List<T>` oder `IEnumerable<T>` explizit in Arrays umzuwandeln.
2.  **Einfacherer Code** – Methodenaufrufe werden sauberer und besser lesbar, da kompatible Sammlungstypen direkt akzeptiert werden.
3.  **Bessere Wartbarkeit** – reduziert sich wiederholenden und fehleranfälligen Code und konzentriert sich auf die Logik statt auf Konvertierungen.

## Compiler-Verhalten und Überladungsauflösung

Die Einführung von params-Collections bringt Anpassungen am Compiler-Verhalten mit sich, insbesondere bei der Überladungsauflösung. Wenn eine Methode einen `params`-Parameter eines Nicht-Array-Sammlungstyps enthält, prüft der Compiler die Anwendbarkeit sowohl der normalen als auch der erweiterten Form der Methode.

## Fehlerbehandlung und Best Practices

Wenn Sie `params` verwenden, sollten Sie Best Practices einhalten, um häufige Fehler zu vermeiden:

-   **Parameterposition** – stellen Sie sicher, dass der `params`-Parameter der letzte in der formalen Parameterliste ist
-   **Modifier-Einschränkungen** – kombinieren Sie `params` nicht mit Modifiern wie `in`, `ref` oder `out`
-   **Standardwerte** – weisen Sie `params`-Parametern keine Standardwerte zu, das ist nicht erlaubt

Weitere Details finden Sie in der [Funktionsspezifikation](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-13.0/params-collections).
