---
title: "C# 13: используйте params-коллекции с любым распознаваемым типом коллекции"
description: "C# 13 расширяет params на поддерживаемые коллекции. Элементы, обычная и развёрнутая формы вызова, требования к типам и выделение памяти."
pubDate: 2025-01-02
updatedDate: 2026-11-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ru"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---

C# 13 разрешает `params` не только для одномерных массивов, но и для поддерживаемых коллекций. Развёрнутый вызов передаёт отдельные **элементы**, а не переменное число Span.

**Исправление — 2 ноября 2026 года:** уточнены элементы и требования к коллекциям. Передавать список обычному параметру `IEnumerable<T>` можно было и до C# 13. Оба примера проверены с SDK 10.0.302 и `LangVersion` 13.

## Параметры Span

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

Обычная форма передаёт существующее значение, преобразуемое к типу параметра. Развёрнутая форма передаёт элементы, из которых компилятор создаёт коллекцию. `ReadOnlySpan<T>` может исключить массив в подходящих вызовах, но не гарантирует отсутствие выделений памяти для любых типов и вызовов.

## Поддерживаемые коллекции

Допустимы `Span<T>`, `ReadOnlySpan<T>`, поддерживаемые обобщённые интерфейсы и типы с builder, совместимые с выражениями коллекций. Конструируемой коллекции нужны требуемый доступный конструктор без параметров, подходящий экземплярный метод `Add` и поддержка перечисления. Одних `IEnumerable<T>` и произвольного метода с именем `Add` недостаточно.

Интерфейсы включают `IEnumerable<T>`, `IReadOnlyCollection<T>`, `IReadOnlyList<T>`, `ICollection<T>` и `IList<T>`.

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

Первый вызов работал и раньше с обычным параметром `IEnumerable<int>` без `params`. C# 13 добавляет для этого типа развёрнутую форму `Print(4, 5, 6)`. Создание коллекции для неё может выделять память.

`params` должен идти последним, не иметь значения по умолчанию и не сочетаться с `ref`, `in` или `out`. Добавление перегрузок с params-коллекциями может изменить выбор перегрузки при перекомпиляции потребителей; проверяйте реальные вызовы.

О владении и представлениях см. [List, Span и ReadOnlySpan](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Источники

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
