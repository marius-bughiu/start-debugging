---
title: "C# Случайный выбор элементов из списка"
description: "В C# можно случайным образом выбирать элементы из списка с помощью Random.GetItems — метода, появившегося в .NET 8. Узнайте, как это работает, на практических примерах."
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/c-randomly-choose-items-from-a-list"
translatedBy: "claude"
translationDate: 2026-05-01
---
В C# можно случайным образом выбирать элементы из списка с помощью `Random.GetItems` — метода, появившегося в .NET 8.

```cs
public T[] GetItems<T>(T[] choices, int length)
```

Метод принимает два параметра:

-   `choices` — список элементов, из которых выбирать / список вариантов.
-   `length` — сколько элементов выбрать.

Об этом методе важно знать две вещи:

-   результирующий список может содержать дубликаты, это не список уникальных выборов.
-   это позволяет параметру `length` быть больше длины списка вариантов.

С учётом сказанного давайте рассмотрим несколько примеров. Предположим, есть следующий массив вариантов:

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

Чтобы выбрать 2 случайных фрукта из этого списка, мы просто вызываем:

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

Как я уже отметил ранее, два выбранных фрукта не обязательно уникальны. Например, в массиве `chosen` вы можете получить `[ "kiwi", "kiwi" ]`. Это легко проверить с помощью do-while:

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

И это позволяет методу выбирать больше элементов, чем у вас действительно есть в списке. В нашем примере доступно всего 4 фрукта, но мы можем попросить `GetItems` выбрать 10 фруктов, и он с готовностью это сделает.

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
