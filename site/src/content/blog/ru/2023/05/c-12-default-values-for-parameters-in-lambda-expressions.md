---
title: "C# 12 - Значения по умолчанию для параметров в лямбда-выражениях"
description: "C# 12 позволяет задавать значения по умолчанию для параметров и массивы params в лямбда-выражениях так же, как в методах и локальных функциях."
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/05/c-12-default-values-for-parameters-in-lambda-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с C# 12, вы можете задавать значения по умолчанию для параметров в лямбда-выражениях. Синтаксис и ограничения на значения по умолчанию такие же, как для методов и локальных функций.

Рассмотрим пример:

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

Теперь эту лямбду можно вызывать так:

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## Массив params в лямбда-выражениях

Лямбда-выражения также можно объявлять с массивом **params** в качестве параметра:

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

И использовать их так же, как любую другую функцию:

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## Ошибка CS8652

> The feature 'lambda optional parameters' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Чтобы использовать необязательные параметры лямбд, ваш проект должен быть нацелен на .NET 8 и C# 12 или новее. Если вы не уверены, как перейти на C# 12, ознакомьтесь со статьёй: [Как перейти на C# 12](/ru/2023/06/how-to-switch-to-c-12/).
