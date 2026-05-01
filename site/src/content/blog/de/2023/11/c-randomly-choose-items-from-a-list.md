---
title: "C# Zufällig Elemente aus einer Liste auswählen"
description: "In C# können Sie mit Random.GetItems, einer in .NET 8 eingeführten Methode, zufällig Elemente aus einer Liste auswählen. Lernen Sie, wie es mit praktischen Beispielen funktioniert."
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/c-randomly-choose-items-from-a-list"
translatedBy: "claude"
translationDate: 2026-05-01
---
In C# können Sie mit `Random.GetItems`, einer in .NET 8 eingeführten Methode, zufällig Elemente aus einer Liste auswählen.

```cs
public T[] GetItems<T>(T[] choices, int length)
```

Die Methode nimmt zwei Parameter entgegen:

-   `choices` -- die Liste der Elemente, aus denen ausgewählt werden soll / die Liste der Möglichkeiten.
-   `length` -- wie viele Elemente ausgewählt werden sollen.

Bei dieser Methode sind zwei wichtige Dinge zu beachten:

-   die resultierende Liste kann Duplikate enthalten, es handelt sich nicht um eine Liste eindeutiger Auswahlen.
-   dies eröffnet die Möglichkeit, dass der Parameter `length` größer ist als die Länge der Auswahlliste.

Vor diesem Hintergrund sehen wir uns einige Beispiele an. Nehmen wir folgendes Array an Auswahlmöglichkeiten an:

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

Um 2 zufällige Früchte aus dieser Liste auszuwählen, rufen wir einfach auf:

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

Wie zuvor erwähnt, sind die beiden ausgewählten Früchte nicht zwangsläufig eindeutig. Sie könnten beispielsweise `[ "kiwi", "kiwi" ]` als Ihr `chosen`-Array erhalten. Sie können dies leicht mit einem do-while testen:

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

Und dies eröffnet der Methode die Möglichkeit, mehr Elemente auszuwählen, als Sie tatsächlich in der Liste haben. In unserem Beispiel stehen nur 4 Früchte zur Auswahl, aber wir können `GetItems` bitten, 10 Früchte für uns auszuwählen, und sie wird das problemlos tun.

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
