---
title: "Los indexadores de extensión de C# 15 completan los miembros de extensión en .NET 11 Preview 6"
description: "Los indexadores de extensión llegaron en .NET 11 Preview 6 y te permiten agregar acceso this[...] a tipos que no controlas. Completan la historia de los miembros de extensión que empezó con métodos y propiedades en C# 14."
pubDate: 2026-07-18
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "extension-members"
lang: "es"
translationOf: "2026/07/csharp-15-extension-indexers-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-18
---

.NET 11 Preview 6 se publicó el 2026-07-14, y escondida en la sección de C# de las notas de la versión está la pieza que por fin hace que los miembros de extensión se sientan completos: los indexadores de extensión. Los métodos de extensión existen desde C# 3.0, las propiedades de extensión llegaron con el [bloque de extensión en C# 14](/es/2026/06/how-to-declare-extension-properties-in-csharp-14/), y ahora puedes añadir acceso `this[...]` a un tipo que no controlas.

## Lo que faltaba hasta ahora

La solución obvia siempre ha sido un método de extensión normal. Si querías semántica de índice desde el final sobre un `IReadOnlyList<T>`, que no lleva un indexador que entienda `Index`, escribías algo así:

```csharp
public static class ReadOnlyListExtensions
{
    public static T At<T>(this IReadOnlyList<T> list, Index index)
        => list[index.GetOffset(list.Count)];
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log.At(^1));   // done
Console.WriteLine(log.At(^2));   // work
```

Funciona, pero el punto de llamada se lee como `log.At(^1)` en lugar de la sintaxis `log[^1]` que te da cualquier otro tipo parecido a una lista. Pierdes la notación de corchetes, y la pierdes también en los patrones de lista.

## La versión con indexador de extensión

C# 15 te permite declarar el indexador dentro de un bloque `extension`, exactamente como declararías un indexador de instancia:

```csharp
public static class ReadOnlyListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public T this[Index index] => list[index.GetOffset(list.Count)];
    }
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log[^1]);   // done
Console.WriteLine(log[^2]);   // work
```

El receptor capturado por el encabezado `extension<T>(IReadOnlyList<T> list)` está en el ámbito dentro del cuerpo, así que el indexador reenvía directamente a `list`. El punto de llamada ahora usa sintaxis de indexador real y, como el compilador lo trata como un indexador, participa en los patrones de lista y en las expresiones de rango igual que lo haría uno integrado.

Los indexadores de extensión no se limitan a la forma de un solo parámetro y solo lectura. Admiten varios parámetros y los accesores `get` y `set`, así que puedes proyectar una búsqueda bidimensional sobre un almacenamiento plano o exponer una vista de escritura sobre un tipo que solo ofrece acceso basado en métodos.

## Cómo activarlo

Esto sigue siendo una característica de lenguaje en versión preliminar, así que no se activa en la versión de lenguaje predeterminada. Agrega lo siguiente a tu `.csproj`:

```xml
<LangVersion>preview</LangVersion>
```

Los indexadores de extensión son el último de los tres tipos clásicos de miembros en llegar a los bloques de extensión, lo que significa que el modelo mental ahora es uniforme: métodos, propiedades e indexadores se declaran de la misma forma dentro de `extension(...)`. Si has estado recurriendo a tipos envoltorio o a incómodos ayudantes `.At()` para tapar un indexador que faltaba, Preview 6 es la versión que te permite eliminarlos. Consulta la [sección de C# de las notas de la versión Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/csharp.md) para el análisis completo.
