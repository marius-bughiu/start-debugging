---
title: "C# 12 Inline Arrays"
description: "Inline Arrays ermöglichen es, ein Array fester Größe innerhalb eines struct-Typs anzulegen. Eine solche Struct mit Inline-Buffer sollte eine Leistung erreichen, die mit einem unsafe Fixed-Size-Buffer vergleichbar ist. Inline Arrays sind in erster Linie für das Runtime-Team und einige Bibliotheksautoren gedacht, um in bestimmten Szenarien die Performance zu verbessern. Sie..."
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/08/c-12-inline-arrays"
translatedBy: "claude"
translationDate: 2026-05-01
---
Inline Arrays ermöglichen es, ein Array fester Größe innerhalb eines `struct`-Typs anzulegen. Eine solche Struct mit Inline-Buffer sollte eine Leistung erreichen, die mit einem unsafe Fixed-Size-Buffer vergleichbar ist.

Inline Arrays sind vor allem für das Runtime-Team und einige Bibliotheksautoren gedacht, um in bestimmten Szenarien die Performance zu verbessern. Wahrscheinlich werden Sie keine eigenen Inline Arrays deklarieren, aber Sie nutzen sie transparent, wenn die Laufzeit sie als `Span<T>` oder `ReadOnlySpan<T>` bereitstellt.

## Wie Sie ein Inline Array deklarieren

Sie deklarieren ein Inline Array, indem Sie eine Struct erzeugen und mit dem Attribut `InlineArray` versehen, das die Array-Länge als Konstruktorparameter erhält.

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

Hinweis: Der Name des privaten Members ist unerheblich. Sie können auch `private int _abracadabra`; verwenden, wenn Sie möchten. Wichtig ist der Typ, denn er bestimmt den Typ Ihres Arrays.

## Verwendung von InlineArray

Sie können ein Inline Array ähnlich wie jedes andere Array verwenden, allerdings mit ein paar kleinen Unterschieden. Sehen wir uns ein Beispiel an:

```cs
var arr = new MyInlineArray();

for (int i = 0; i < 10; i++)
{
    arr[i] = i;
}

foreach (var item in arr)
{
    Console.WriteLine(item);
}
```

Zuerst fällt auf, dass wir bei der Initialisierung keine Größe angeben. Inline Arrays haben eine feste Größe, die über das `InlineArray`-Attribut der `struct` festgelegt wird. Davon abgesehen sieht alles aus wie bei einem normalen Array, aber es gibt noch mehr.

### InlineArray besitzt keine Length-Eigenschaft

Manche werden bemerkt haben, dass die `for`-Schleife oben bis `10` läuft und nicht bis `arr.Length`. Das liegt daran, dass Inline Arrays keine `Length`-Eigenschaft wie normale Arrays bereitstellen.

Es wird sogar noch ungewöhnlicher...

### InlineArray implementiert IEnumerable nicht

Daraus folgt, dass Sie auf einem Inline Array kein `GetEnumerator` aufrufen können. Der Hauptnachteil: LINQ funktioniert auf Inline Arrays nicht, zumindest aktuell nicht; das kann sich künftig ändern.

Obwohl Inline Arrays `IEnumerable` nicht implementieren, können Sie sie dennoch in einer `foreach`-Schleife verwenden.

```cs
foreach (var item in arr) { }
```

Ebenso können Sie den Spread-Operator zusammen mit Inline Arrays nutzen.

```cs
int[] m = [1, 2, 3, ..arr];
```
