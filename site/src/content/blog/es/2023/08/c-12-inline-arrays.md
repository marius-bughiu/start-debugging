---
title: "C# 12 Inline arrays"
description: "Los inline arrays te permiten crear un array de tamaño fijo dentro de un tipo struct. Esa struct, con un buffer inline, ofrece un rendimiento comparable al de un buffer unsafe de tamaño fijo. Los inline arrays están pensados sobre todo para ser utilizados por el equipo del runtime y por algunos autores de librerías para mejorar el rendimiento en ciertos escenarios. Probablemente..."
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/08/c-12-inline-arrays"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los inline arrays te permiten crear un array de tamaño fijo dentro de un tipo `struct`. Esa struct, con un buffer inline, debería ofrecer un rendimiento comparable al de un buffer unsafe de tamaño fijo.

Los inline arrays están pensados sobre todo para ser utilizados por el equipo del runtime y por algunos autores de bibliotecas para mejorar el rendimiento en determinados escenarios. Probablemente no declares tus propios inline arrays, pero los usarás de forma transparente cuando el runtime los exponga como objetos `Span<T>` o `ReadOnlySpan<T>`.

## Cómo declarar un inline array

Puedes declarar un inline array creando una struct y envolviéndola con el atributo `InlineArray`, que recibe la longitud del array como parámetro en el constructor.

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

Nota: el nombre del miembro privado es irrelevante. Puedes usar `private int _abracadabra`; si quieres. Lo que importa es el tipo, ya que decide el tipo de tu array.

## Uso de InlineArray

Puedes usar un inline array de forma parecida a cualquier otro array, pero con algunas pequeñas diferencias. Veamos un ejemplo:

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

Lo primero que hay que notar es que durante la inicialización no especificamos el tamaño. Los inline arrays son de tamaño fijo y su longitud se define mediante el atributo `InlineArray` aplicado a la `struct`. Aparte de eso, todo se ve como con un array normal, pero hay algo más.

### InlineArray no tiene una propiedad Length

Algunos os habréis fijado en que en el bucle `for` anterior hemos iterado hasta `10` en lugar de hasta `arr.Length`, y eso es porque los inline arrays no exponen una propiedad `Length` como sí hacen los arrays normales.

Y se vuelve aún más raro...

### InlineArray no implementa IEnumerable

Como resultado, no puedes llamar a `GetEnumerator` en un inline array. La principal desventaja es que no puedes usar LINQ con inline arrays, al menos por ahora; esto puede cambiar en el futuro.

A pesar de no implementar `IEnumerable`, todavía puedes usarlos en un bucle `foreach`.

```cs
foreach (var item in arr) { }
```

De forma similar, también puedes usar el operador spread junto con los inline arrays.

```cs
int[] m = [1, 2, 3, ..arr];
```
