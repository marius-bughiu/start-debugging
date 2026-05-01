---
title: "C# 13: Usa colecciones params con cualquier tipo de colección reconocido"
description: "C# 13 extiende el modificador params más allá de los arrays para soportar Span, ReadOnlySpan, IEnumerable y otros tipos de colecciones, reduciendo el código repetitivo y mejorando la flexibilidad."
pubDate: 2025-01-02
updatedDate: 2025-01-07
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---
El modificador `params` en C# se ha asociado tradicionalmente con tipos array, permitiendo que los métodos acepten un número variable de argumentos. Sin embargo, [a partir de C# 13](/es/2025/01/how-to-switch-to-c-13/), ahora puedes usar colecciones params con una variedad de tipos de colección, ampliando su aplicabilidad y haciendo tu código aún más versátil.

## Tipos de colección soportados

El modificador `params` ahora funciona con varios tipos de colección reconocidos, incluyendo:

-   `System.Span<T>`
-   `System.ReadOnlySpan<T>`
-   tipos que implementan `System.Collections.Generic.IEnumerable<T>` y que también tienen un método `Add`.

Adicionalmente, puedes usar `params` con las siguientes interfaces del sistema:

-   `System.Collections.Generic.IEnumerable<T>`
-   `System.Collections.Generic.IReadOnlyCollection<T>`
-   `System.Collections.Generic.IReadOnlyList<T>`
-   `System.Collections.Generic.ICollection<T>`
-   `System.Collections.Generic.IList<T>`

## Un ejemplo práctico: usando Spans con `params`

Una de las posibilidades emocionantes con esta mejora es la capacidad de usar spans como parámetros `params`. Aquí hay un ejemplo:

```cs
public void Concat<T>(params ReadOnlySpan<T> items)
{
    for (int i = 0; i < items.Length; i++)
    {
        Console.Write(items[i]);
        Console.Write(" ");
    }

    Console.WriteLine();
}
```

En este método, `params` te permite pasar un número variable de spans al método `Concat`. El método procesa cada span en secuencia, demostrando la flexibilidad mejorada del modificador `params`.

## Comparación con C# 12.0

En versiones anteriores de C#, la palabra clave `params` solo soportaba arrays, lo que requería que los desarrolladores convirtieran manualmente otros tipos de colecciones en arrays antes de pasarlos a un método que usara `params`. Este proceso añadía código repetitivo innecesario, como crear arrays temporales o llamar explícitamente a métodos de conversión.

**Ejemplo sin la nueva característica (Pre-C# 13)**

```cs
void PrintValues(params int[] values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// Manual conversion to array
PrintValues(list.ToArray());
```

**Ejemplo con la nueva característica (C# 13)**

```cs
void PrintValues(params IEnumerable<int> values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// No conversion needed
PrintValues(list);
```

La nueva característica reduce el código repetitivo al:

1.  **Eliminar la conversión manual** – no hace falta convertir explícitamente colecciones como `List<T>` o `IEnumerable<T>` a arrays.
2.  **Hacer el código** **más simple** – las llamadas a métodos quedan más limpias y legibles, aceptando directamente tipos de colección compatibles.
3.  **Mejorar la mantenibilidad** – reduce código repetitivo y propenso a errores, enfocándose solo en la lógica en lugar de manejar conversiones.

## Comportamiento del compilador y resolución de sobrecargas

La introducción de las colecciones params implica ajustes en el comportamiento del compilador, particularmente en lo que respecta a la resolución de sobrecargas. Cuando un método incluye un parámetro `params` de un tipo de colección no array, el compilador evalúa la aplicabilidad de las formas normal y expandida del método.

## Manejo de errores y mejores prácticas

Cuando uses `params`, es importante seguir las mejores prácticas para evitar errores comunes:

-   **posición del parámetro** – asegúrate de que el parámetro `params` sea el último en la lista de parámetros formales
-   **restricciones de modificadores** – evita combinar `params` con modificadores como `in`, `ref` u `out`
-   **valores por defecto** – no asignes valores por defecto a los parámetros `params`, ya que no está permitido

Para más detalles puedes consultar la [especificación de la característica](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-13.0/params-collections).
