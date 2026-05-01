---
title: "C# 12 - Standardwerte für Parameter in Lambda-Ausdrücken"
description: "C# 12 erlaubt es, Standardwerte für Parameter und params-Arrays in Lambda-Ausdrücken anzugeben, genau wie in Methoden und lokalen Funktionen."
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/05/c-12-default-values-for-parameters-in-lambda-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab C# Version 12 können Sie Standardwerte für die Parameter in Lambda-Ausdrücken angeben. Die Syntax und die Einschränkungen für die Standardparameterwerte sind dieselben wie bei Methoden und lokalen Funktionen.

Ein Beispiel:

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

Diese Lambda kann nun wie folgt verwendet werden:

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## params-Array in Lambda-Ausdrücken

Sie können Lambda-Ausdrücke auch mit einem **params**-Array als Parameter deklarieren:

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

Und sie wie jede andere Funktion verwenden:

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## Fehler CS8652

> The feature 'lambda optional parameters' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Ihr Projekt muss auf .NET 8 und C# 12 oder neuer zielen, um die optionalen Lambda-Parameter zu nutzen. Falls Sie nicht sicher sind, wie Sie auf C# 12 umstellen, sehen Sie sich diesen Artikel an: [Wie Sie zu C# 12 wechseln](/de/2023/06/how-to-switch-to-c-12/).
