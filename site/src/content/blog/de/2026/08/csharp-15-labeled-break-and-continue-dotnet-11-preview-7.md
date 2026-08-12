---
title: "C# 15 erhält beschriftetes break und continue in .NET 11 Preview 7"
description: "Beschriftetes break und continue sind im C#-Abschnitt von .NET 11 Preview 7 gelandet. Eine Schleife lässt sich jetzt mit einem Label versehen und direkt anspringen, was die Umwege über Boolesche Flags und goto bei verschachtelten Schleifen überflüssig macht."
pubDate: 2026-08-12
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "language-features"
lang: "de"
translationOf: "2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-12
---

.NET 11 Preview 7 erschien am 2026-08-11, und der C#-Abschnitt enthält eine Funktion, um die die Community seit gefühlten Ewigkeiten bittet: `break` und `continue` können nun ein Label an einer umschließenden Schleife oder einem `switch` benennen. Der betreute Vorschlag ist [dotnet/csharplang#9875](https://github.com/dotnet/csharplang/issues/9875), und die angehängte Diskussionsliste verweist auf neun separate Community-Threads, die Jahre zurückreichen.

## So sieht die Syntax aus

Das Label steht direkt an der Schleife, und die Sprunganweisung benennt es:

```csharp
outer: for (int row = 0; row < grid.Height; row++)
{
    for (int column = 0; column < grid.Width; column++)
    {
        if (grid[row, column].IsBlocked)
        {
            continue outer;
        }

        if (grid[row, column].IsGoal)
        {
            break outer;
        }
    }
}
```

Ein Label genügt für beide Sprünge. Ohne Label verhalten sich `break` und `continue` genau wie bisher und zielen auf die innerste passende Anweisung. Die Neuerung ist also rein additiv.

## Die beiden Umwege, die damit entfallen

Die Variante mit Boolescher Flag benötigt Zustand, der nur existiert, um den Ausstieg nach außen weiterzureichen, und dieser Zustand muss auf jeder Ebene geprüft werden:

```csharp
bool found = false;
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (i * j > 20)
        {
            found = true;
            break;
        }
    }

    if (found)
        break;
}
```

Die `goto`-Variante ist im continue-Fall noch schlechter, denn das Label muss am Ende des Schleifenrumpfs stehen, damit Inkrement und Bedingung weiterhin ausgeführt werden:

```csharp
for (int i = 0; i < 10; i++)
{
    for (int j = 0; j < 10; j++)
    {
        if (j == 5)
            goto next;
    }

    next: ; // The empty statement is required.
}
```

Das ist brüchig. Jede versehentlich zwischen Label und schließender Klammer eingefügte Anweisung verändert stillschweigend die Wirkung des Sprungs. Die Bindung des Labels an das Schleifenkonstrukt selbst beseitigt diese Fehlerquelle.

## Zwei Regeln, die man vor dem Refactoring kennen sollte

Nur die **unmittelbar** in einer beschrifteten Anweisung verschachtelte Anweisung erhält das Label. Bei `a: b: while (...) ...` beschriftet nur `b` die Schleife. `a` beschriftet die innere beschriftete Anweisung, die selbst keine Schleife ist. Damit ist `break a;` innerhalb dieses Rumpfs ein Compilerfehler statt ein Sprung zum `while`. Die Spezifikation lehnt verschachtelte Labels ausdrücklich ab.

Außerdem kann `break` ein umschließendes `switch` ansprechen, `continue` dagegen nicht. `continue` löst immer auf eine Iterationsanweisung auf, was sich aus der Bedeutung der beiden Sprünge ergibt.

## Der Analyzer, der Ihre bestehenden Fälle findet

Sie müssen den infrage kommenden Code nicht selbst suchen. [IDE0410](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0410) ("Use labeled jump statement") meldet alle drei Muster: ein `goto`, das über eine verschachtelte Schleife hinausspringt, ein `goto` auf ein leeres Label am Ende, und die Weiterreichungskette über eine Boolesche Flag. Die Regel ist über `csharp_style_prefer_labeled_jump_statements = true` standardmäßig aktiv und gilt ab C# 15. Pro Projekt deaktivieren Sie sie so:

```ini
[*.cs]
dotnet_diagnostic.IDE0410.severity = none
```

Zum Ausprobieren benötigen Sie das .NET 11 Preview SDK, genau wie bei den [Extension-Indexern aus Preview 6](/de/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/). Alle Details stehen in der [Feature-Spezifikation](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/labeled-break-continue) und in der [Ankündigung zu Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/).
