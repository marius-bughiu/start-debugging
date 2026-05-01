---
title: "C# Exception werfen, wenn null: ArgumentNullException.ThrowIfNull (.NET 6+)"
description: "Verwenden Sie ArgumentNullException.ThrowIfNull in .NET 6+ für prägnante Null-Prüfungen oder throw-Ausdrücke in C# 7+ für ältere Frameworks."
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/c-best-way-to-throw-exception-if-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 6 hat einige neue Hilfsmethoden für das Werfen von Exceptions eingeführt, eine davon ist **ThrowIfNull**. Die Verwendung ist einfach:

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

Die Methode wirft eine **ArgumentNullException**, wenn **myParam** **null** ist. Andernfalls tut sie nichts.

ThrowIfNull akzeptiert zwei Parameter:

-   **object? argument** -- das Referenztyp-Objekt, das auf null geprüft werden soll
-   Optional: **string? paramName** -- der Name des geprüften Parameters.

**Hinweis:** paramName verwendet **CallerArgumentExpressionAttribute**, um den Namen Ihres Parameters automatisch zu ermitteln. In den meisten Szenarien müssen Sie ihn daher nicht angeben, da das Framework den Argumentnamen selbst korrekt bestimmen kann.

## throw-Ausdrücke

Wenn Sie noch nicht auf .NET 6 oder neuer sind, aber C# 7+ verwenden können, lassen sich throw-Ausdrücke einsetzen, um Ihren Code lesbarer zu machen:

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

Alternativ können Sie eine eigene Implementierung von ThrowIfNull definieren, etwa so:

```cs
/// <summary>Throws an <see cref="ArgumentNullException"/> if <paramref name="argument"/> is null.</summary>
/// <param name="argument">The reference type argument to validate as non-null.</param>
/// <param name="paramName">The name of the parameter with which <paramref name="argument"/> corresponds.</param>
public static void ThrowIfNull([NotNull] object? argument, [CallerArgumentExpression("argument")] string? paramName = null)
{
    if (argument is null)
    {
        throw new ArgumentNullException(paramName);
    }
}
```
