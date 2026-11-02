---
title: "C# 13: Usa colecciones params con cualquier tipo de colección reconocido"
description: "C# 13 amplía params a colecciones reconocidas. Elementos, llamadas normales y expandidas, requisitos de los tipos y posibles asignaciones."
pubDate: 2025-01-02
updatedDate: 2026-11-02
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

C# 13 amplía `params` más allá de los arrays unidimensionales a tipos de colección reconocidos. La llamada expandida pasa **elementos** individuales, no una cantidad variable de spans.

**Corrección — 2 de noviembre de 2026:** se corrigieron la explicación de elementos y los requisitos de las colecciones. Pasar una lista a un parámetro `IEnumerable<T>` normal ya era posible antes de C# 13. Ambos ejemplos se comprobaron con SDK 10.0.302 y `LangVersion` 13.

## Parámetros Span

```csharp
using System;

Print(1, 2, 3); // Expanded form: three int elements.
int[] data = { 4, 5 };
Print(data);    // Normal form: an existing buffer.

static void Print(params ReadOnlySpan<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

La forma normal pasa un valor existente convertible al tipo del parámetro. La expandida proporciona elementos con los que el compilador construye la colección. `ReadOnlySpan<T>` puede evitar un array en llamadas adecuadas; no garantiza ausencia de asignaciones en todos los tipos y llamadas.

## Colecciones admitidas

Se admiten `Span<T>`, `ReadOnlySpan<T>`, las interfaces genéricas reconocidas y tipos con builder compatibles con expresiones de colección. Las colecciones construibles necesitan el constructor sin parámetros accesible requerido, un método de instancia `Add` adecuado y soporte de enumeración. No basta implementar `IEnumerable<T>` y tener cualquier método llamado `Add`.

Las interfaces incluyen `IEnumerable<T>`, `IReadOnlyCollection<T>`, `IReadOnlyList<T>`, `ICollection<T>` e `IList<T>`.

```csharp
using System;
using System.Collections.Generic;

var values = new List<int> { 1, 2, 3 };
Print(values);  // Normal form.
Print(4, 5, 6); // Expanded form: enabled by params collections in C# 13.

static void Print(params IEnumerable<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

La primera llamada también era válida en versiones anteriores con un parámetro `IEnumerable<int>` sin `params`. C# 13 añade la forma expandida `Print(4, 5, 6)` para ese tipo. La colección creada para esa llamada puede asignar memoria.

`params` debe ser el último parámetro, sin valor predeterminado y sin `ref`, `in` ni `out`. Agregar sobrecargas de colecciones params puede cambiar la resolución de sobrecargas al recompilar consumidores; comprueba las llamadas reales.

Sobre propiedad y vistas, consulta [List, Span y ReadOnlySpan](/es/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Fuentes

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
