---
title: "C# Elegir aleatoriamente elementos de una lista"
description: "En C#, puedes seleccionar aleatoriamente elementos de una lista usando Random.GetItems, un método introducido en .NET 8. Aprende cómo funciona con ejemplos prácticos."
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/c-randomly-choose-items-from-a-list"
translatedBy: "claude"
translationDate: 2026-05-01
---
En C#, puedes seleccionar aleatoriamente elementos de una lista usando `Random.GetItems`, un método introducido en .NET 8.

```cs
public T[] GetItems<T>(T[] choices, int length)
```

El método toma dos parámetros:

-   `choices` -- la lista de elementos entre los que elegir / la lista de posibilidades.
-   `length` -- cuántos elementos seleccionar.

Hay dos cosas importantes que tener en cuenta sobre este método:

-   la lista resultante puede contener duplicados, no es una lista de selecciones únicas.
-   esto abre la posibilidad de que el parámetro `length` sea mayor que la longitud de la lista de opciones.

Dicho esto, veamos algunos ejemplos. Asumamos el siguiente arreglo de opciones:

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

Para seleccionar 2 frutas aleatorias de esa lista, simplemente llamamos:

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

Ahora, como dije antes, las dos frutas elegidas no son necesariamente únicas. Podrías terminar, por ejemplo, con `[ "kiwi", "kiwi" ]` como tu arreglo `chosen`. Puedes probarlo fácilmente con un do-while:

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

Y esto abre la posibilidad de seleccionar más elementos de los que realmente tienes en la lista. En nuestro ejemplo solo tenemos 4 frutas entre las que elegir, pero podemos pedirle a `GetItems` que elija 10 frutas y lo hará sin problemas.

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
