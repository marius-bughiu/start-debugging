---
title: "C# 12 Collection Expressions"
description: "C# 12 bringt eine neue, vereinfachte Syntax zum Erstellen von Arrays. Sie sieht so aus: Wichtig: Der Array-Typ muss explizit angegeben werden, var lässt sich für die Variablendeklaration also nicht verwenden. Genauso können Sie ein Span<int> erstellen: Mehrdimensionale Arrays Die Vorteile dieser knappen Syntax..."
pubDate: 2023-08-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/08/c-12-collection-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 bringt eine neue, vereinfachte Syntax zum Erstellen von Arrays. Sie sieht so aus:

```cs
int[] foo = [1, 2, 3];
```

Wichtig: Der Array-Typ muss explizit angegeben werden, `var` lässt sich für die Variablendeklaration also nicht verwenden.

Genauso können Sie ein `Span<int>` erstellen:

```cs
Span<int> bar = [1, 2, 3];
```

## Mehrdimensionale Arrays

Die Vorteile dieser knappen Syntax werden bei mehrdimensionalen Arrays besonders deutlich. Nehmen wir ein zweidimensionales Array als Beispiel. So würden Sie es ohne die neue Syntax definieren:

```cs
int[][] _2d = new int[][] { new int[] { 1, 2, 3 }, new int[] { 4, 5, 6 }, new int[] { 7, 8, 9 } };
```

Und mit der neuen Syntax:

```cs
int[][] _2d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
```

Deutlich einfacher und intuitiver, oder?

## Arrays mit dem Spread-Operator zusammenführen

Mit der neuen Syntax kommt auch ein neuer Spread-Operator, `..`, der das Argument, auf das er angewendet wird, durch dessen Elemente ersetzt. Damit lassen sich Sammlungen elegant zusammenführen. Sehen wir uns ein paar Beispiele an.

Zuerst ganz einfach: mehrere Arrays zu einem zusammenführen:

```cs
int[] a1 = [1, 2, 3];
int[] a2 = [4, 5, 6];
int[] a3 = [7, 8, 9];

int[] merged = [..a1, ..a2, ..a3];
```

Der Spread-Operator funktioniert mit jedem `IEnumerable` und lässt sich nutzen, um verschiedene `IEnumerable`s in einer einzigen Collection zu vereinen.

```cs
int[] a1 = [1, 2, 3];
List<int> a2 = [4, 5, 6];
Span<int> a3 = [7, 8, 9];

Collection<int> merged = [..a1, ..a2, ..a3];
```

Sie können den Spread-Operator auch mit einzelnen Elementen kombinieren, um eine neue Collection mit zusätzlichen Elementen am Anfang oder Ende einer bestehenden Collection zu erzeugen.

```cs
int[] merged = [1, 2, 3, ..a2, 10, 11, 12];
```

### Error CS9176

> Error CS9176 There is no target type for the collection expression.

Bei Collection Expressions können Sie `var` nicht verwenden, sondern müssen den Variablentyp explizit angeben. Beispiel:

```cs
// Wrong - triggers CS9176
var foo = [1, 2, 3];

// Correct
int[] foo = [1, 2, 3];
```

### Error CS0029

> Error CS0029 Cannot implicitly convert type 'int\[\]' to 'System.Index'

Das passiert, wenn Sie den Spread-Operator in der alten Collection-Initializer-Syntax verwenden möchten, die nicht unterstützt wird. Verwenden Sie stattdessen die neue, vereinfachte Syntax, wenn Sie den Spread-Operator nutzen.

```cs
// Wrong - triggers CS0029
var a = new List<int> { 1, 2, 3, ..a1, 4, 5 };

// Correct
List<int> a = [1, 2, 3, .. a1, 4, 5];
```

### Error CS8652

> Error CS8652 The feature 'collection expressions' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

> Error CS8652 The feature 'collection literals' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Diese Fehler bedeuten, dass Ihr Projekt noch nicht auf C# 12 läuft, sodass die neuen Sprachfeatures nicht verfügbar sind. Wenn Sie auf C# 12 wechseln möchten und nicht wissen, wie, sehen Sie sich [unsere Anleitung zum Umstieg auf C# 12](/2023/06/how-to-switch-to-c-12/) an.
