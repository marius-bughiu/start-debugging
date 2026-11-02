---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> в C#: когда что выбирать"
description: "List<T> для растущих коллекций, Span<T> для изменяемого представления и ReadOnlySpan<T> для чтения: время жизни, возврат и ограничения async."
pubDate: 2026-05-25
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "ru"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

`List<T>` управляет растущей коллекцией. `Span<T>` — представление непрерывной памяти фиксированной длины, а `ReadOnlySpan<T>` запрещает запись через это представление. Представление не заменяет владение буфером и управление его временем жизни.

**Исправление — 2 ноября 2026 года:** удалены неподтверждённые числа бенчмарков .NET 11; исправлены утверждения о возврате, полях и версиях. Примеры проверены с SDK 10.0.302 и C# 14. Универсальное ускорение не заявляется.

## Выбор по владению и времени жизни

| Задача | Отправная точка |
| --- | --- |
| Постепенно добавлять элементы | `List<T>` |
| Синхронно читать или менять непрерывную область | `Span<T>` |
| Читать без записи через представление | `ReadOnlySpan<T>` |
| Хранить представление в классе или через `await` | `Memory<T>` / `ReadOnlyMemory<T>` |

Span не владеет буфером. Span на массив можно вернуть, если время жизни памяти допускает это. Span на локальный `stackalloc` вернуть нельзя. Он может быть полем другого `ref struct`, но не обычного класса или структуры; упаковка и захват лямбдой запрещены.

Начиная с C# 13, локальные ref-struct-переменные допустимы в async-методах, если не остаются живыми через `await`. Для этой границы используйте Memory. Представление только для чтения не делает буфер неизменяемым: другой псевдоним может его изменить.

## Изменение без копирования

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

Оба представления используют исходную память. `Tail` возвращает допустимый Span на массив, а не локальный стековый буфер. Пока используется представление из `CollectionsMarshal.AsSpan`, нельзя добавлять или удалять элементы списка, даже без изменения размера внутреннего массива. Предпочитайте обычную API списка, пока измерения не покажут необходимость такого доступа.

## Вход только для чтения

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

Строки предоставляют `ReadOnlySpan<char>`, UTF-8-литералы — `ReadOnlySpan<byte>`. Изменяемый Span преобразуется в доступный только для чтения, но не наоборот. Используйте наиболее ограниченный тип параметра, достаточный для операции.

C# 14 вышел с .NET 10. Базовые неявные преобразования массивов в Span существовали раньше; C# 14 расширил языковую поддержку вывода типов и получателей методов расширения. `allows ref struct` из C# 13 допускает такие обобщённые аргументы лишь в явно поддерживающей их API. Это не разрешает `List<Span<int>>`.

## Измерять конкретную операцию

Срезы Span могут исключить копирование и выделение подстрок. Они не гарантируют преимущество любого цикла над списком: важны JIT, runtime, объём данных и работа. Создание строки, массива или списка всё ещё может выделять память. Публикуйте замеры вместе с полным кодом, конфигурацией и выводом.

Для async-буферов см. [преобразование массива в ReadOnlyMemory](/ru/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/). Для обработки и временных буферов — [когда Span может повысить производительность](/ru/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

## Источники

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
