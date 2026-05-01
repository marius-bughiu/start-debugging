---
title: "Gibt es in C# ein Äquivalent zur With...End With-Anweisung?"
description: "Die With...End With-Anweisung in VB führt eine Reihe von Anweisungen aus, die sich wiederholt auf ein einziges Objekt beziehen, mit einer vereinfachten Syntax für den Zugriff auf dessen Member. Gibt es in C# ein Äquivalent? Nein. Am nächsten kommen Objektinitialisierer, die jedoch nur beim Erzeugen neuer Objekte funktionieren."
pubDate: 2023-08-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/08/is-there-a-c-with-end-with-statement-equivalent"
translatedBy: "claude"
translationDate: 2026-05-01
---
Die With...End With-Anweisung in VB führt eine Reihe von Anweisungen aus, die sich wiederholt auf ein einziges Objekt beziehen. Dadurch können die Anweisungen eine vereinfachte Syntax für den Zugriff auf die Member des Objekts verwenden. Zum Beispiel:

```vb
With car
    .Make = "Mazda"
    .Model = "MX5"
    .Year = 1989
End With
```

## Gibt es in C# ein syntaktisches Äquivalent?

Nein. Es existiert nicht. Am nächsten kommen die Objektinitialisierer, doch diese sind nur für die Instanziierung neuer Objekte gedacht; bestehende Objektinstanzen lassen sich damit nicht aktualisieren, wie es die with-Anweisung erlaubt.

Beim Erzeugen einer neuen Objektinstanz können Sie zum Beispiel den Objektinitialisierer verwenden:

```cs
var car = new Car
{
    Make = "Mazda",
    Model = "MX5",
    Year = 1989
};
```

Beim Aktualisieren des Objekts gibt es jedoch keine vergleichbare vereinfachte Syntax. Sie müssten das Objekt für jede Zuweisung oder jeden Memberaufruf einzeln referenzieren, etwa so:

```cs
car.Make = "Aston Martin";
car.Model = "DBS";
car.Year = 1967;
```
