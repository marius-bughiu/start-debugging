---
title: "C# как перемешать массив?"
description: "Самый простой способ перемешать массив в C# — использовать Random.Shuffle, появившийся в .NET 8. Метод работает in-place как с массивами, так и со спанами."
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/c-how-to-shuffle-an-array"
translatedBy: "claude"
translationDate: 2026-05-01
---
Самый простой способ перемешать массив в C# — использовать `Random.Shuffle`. Этот метод появился в .NET 8 и работает как с массивами, так и со спанами.

Перемешивание выполняется in-place (изменяется существующий массив или спан, а не создаётся новый объект с оставлением исходного нетронутым).

Сигнатуры выглядят так:

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

Простой пример использования:

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(foo); // [2, 1, 3]
```
