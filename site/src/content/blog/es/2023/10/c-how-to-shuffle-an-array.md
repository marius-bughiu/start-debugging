---
title: "C# ¿Cómo barajar un array?"
description: "La forma más sencilla de barajar un array en C# es usando Random.Shuffle, introducido en .NET 8. Funciona in-place tanto con arrays como con spans."
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/c-how-to-shuffle-an-array"
translatedBy: "claude"
translationDate: 2026-05-01
---
La forma más sencilla de barajar un array en C# es usando `Random.Shuffle`. Este método se introdujo en .NET 8 y funciona tanto con arrays como con spans.

El barajado se hace in-place (se modifica el array/span existente en lugar de crear uno nuevo y dejar el original sin cambios).

En cuanto a las firmas, tenemos:

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

Y un ejemplo de uso sencillo:

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(foo); // [2, 1, 3]
```
