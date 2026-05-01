---
title: "C# 12 expresiones de colección"
description: "C# 12 introduce una nueva sintaxis simplificada para crear arrays. Tiene este aspecto: Es importante señalar que el tipo del array hay que especificarlo de forma explícita, por lo que no puedes usar var para declarar la variable. De forma similar, si quisieras crear un Span<int>, puedes hacer: Arrays multidimensionales Las ventajas de esta sintaxis concisa..."
pubDate: 2023-08-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/08/c-12-collection-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 introduce una nueva sintaxis simplificada para crear arrays. Tiene este aspecto:

```cs
int[] foo = [1, 2, 3];
```

Es importante señalar que el tipo del array hay que especificarlo de forma explícita, por lo que no puedes usar `var` para declarar la variable.

De forma similar, si quisieras crear un `Span<int>`, puedes hacer:

```cs
Span<int> bar = [1, 2, 3];
```

## Arrays multidimensionales

Las ventajas de esta sintaxis concisa se vuelven aún más evidentes al definir arrays multidimensionales. Tomemos un array bidimensional como ejemplo. Así lo definirías sin la nueva sintaxis:

```cs
int[][] _2d = new int[][] { new int[] { 1, 2, 3 }, new int[] { 4, 5, 6 }, new int[] { 7, 8, 9 } };
```

Y con la nueva sintaxis:

```cs
int[][] _2d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
```

Mucho más simple e intuitivo, ¿verdad?

## Combinar arrays con el operador spread

Con la nueva sintaxis también llega un nuevo operador spread, `..`, que reemplaza el argumento al que se aplica por sus elementos, lo que te permite combinar colecciones. Veamos algunos ejemplos.

Empezando por el más simple, fusionar varios arrays en uno:

```cs
int[] a1 = [1, 2, 3];
int[] a2 = [4, 5, 6];
int[] a3 = [7, 8, 9];

int[] merged = [..a1, ..a2, ..a3];
```

El operador spread se puede aplicar a cualquier `IEnumerable` y se puede usar para combinar diferentes `IEnumerable` en una sola colección.

```cs
int[] a1 = [1, 2, 3];
List<int> a2 = [4, 5, 6];
Span<int> a3 = [7, 8, 9];

Collection<int> merged = [..a1, ..a2, ..a3];
```

También puedes usar el operador spread junto con elementos individuales, para crear una nueva colección con elementos adicionales en cualquiera de los extremos de una colección existente.

```cs
int[] merged = [1, 2, 3, ..a2, 10, 11, 12];
```

### Error CS9176

> Error CS9176 There is no target type for the collection expression.

En el caso de las expresiones de colección no puedes usar `var` y debes especificar explícitamente el tipo de la variable. Veamos un ejemplo:

```cs
// Wrong - triggers CS9176
var foo = [1, 2, 3];

// Correct
int[] foo = [1, 2, 3];
```

### Error CS0029

> Error CS0029 Cannot implicitly convert type 'int\[\]' to 'System.Index'

Esto puede ocurrir al intentar usar el operador spread con la antigua sintaxis de inicializador de colección, que no está soportada. En su lugar, debes usar la sintaxis simplificada cuando uses el operador spread.

```cs
// Wrong - triggers CS0029
var a = new List<int> { 1, 2, 3, ..a1, 4, 5 };

// Correct
List<int> a = [1, 2, 3, .. a1, 4, 5];
```

### Error CS8652

> Error CS8652 The feature 'collection expressions' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

> Error CS8652 The feature 'collection literals' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Estos errores significan que tu proyecto aún no usa C# 12, así que no puedes usar las nuevas características del lenguaje. Si quieres cambiar a C# 12 y no sabes cómo, mira [nuestra guía para migrar tu proyecto a C# 12](/2023/06/how-to-switch-to-c-12/).
