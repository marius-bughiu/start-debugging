---
title: "C# ref readonly-Parameter"
description: "Der ref readonly-Modifier in C# bietet eine transparentere Möglichkeit, schreibgeschützte Referenzen zu übergeben. Erfahren Sie, wie er den in-Modifier mit besseren Einschränkungen und mehr Sichtbarkeit für den Aufrufer verbessert."
pubDate: 2023-10-28
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/10/csharp-ref-readonly-parameters"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der `ref readonly`-Modifier ermöglicht eine transparentere Übergabe von schreibgeschützten Referenzen an eine Methode. Schon seit C# 7.2 lassen sich readonly-Referenzen über den `in`-Modifier übergeben, doch diese Syntax hatte einige Einschränkungen, oder besser gesagt zu wenige Einschränkungen.

Wie funktioniert nun der neue Modifier? Nehmen wir die folgende Methodensignatur an:

```cs
void FooRef(ref readonly int bar) { }
```

Die Methode einfach mit einer ganzzahligen Variable oder einem Wert aufzurufen, führt zu einer Compiler-**Warnung**. Beachten Sie: Das ist nur eine Warnung. Sie weist auf eine Mehrdeutigkeit in Ihrer Implementierung hin, lässt den Code aber weiterhin laufen, wenn Sie darauf bestehen.

```cs
var x = 42;

FooRef(x);
FooRef(42);
```

-   `FooRef(x)` löst die Warnung CS9192 aus: Argument 1 should be passed with 'ref' or 'in' keyword
-   `FooRef(42)` löst die Warnung CS9193 aus: Argument 1 should be a variable because it is passed to a 'ref readonly' parameter

Schauen wir uns beide einzeln an.

## `FooRef(x)`: `ref` oder `in` verwenden

Das ist eine der Verbesserungen gegenüber dem `in`-Modifier. `ref readonly` macht für den Aufrufer explizit, dass der Wert als Referenz übergeben wird. Bei `in` war das nicht transparent und konnte zu Verwirrung führen.

Um CS9192 zu beheben, ändern Sie den Aufruf einfach in `FooRef(ref x)` oder `FooRef(in x)`. Die beiden Annotationen sind weitgehend gleichwertig, mit dem Hauptunterschied, dass `in` toleranter ist und auch nicht zuweisbare Werte akzeptiert, während `ref` eine zuweisbare Variable verlangt.

Zum Beispiel:

```cs
readonly int y = 43;

FooRef(in y);
FooRef(ref y);
```

`FooRef(in y)` funktioniert problemlos, während `FooRef(ref y)` einen Compiler-Fehler auslöst, der besagt, dass der ref-Wert eine zuweisbare Variable sein muss.

## `FooRef(42)`: nur Variablen sind erlaubt

Das ist die andere Verbesserung, die `ref readonly` gegenüber `in` bringt: Es beschwert sich, sobald Sie versuchen, einen rvalue zu übergeben, also einen Wert ohne Speicherort. Das passt zur Warnung von oben: Wenn Sie `FooRef(ref 42)` versuchen, erhalten Sie sofort den Compiler-Fehler CS1510: A ref or out value must be an assignable variable.
