---
title: "Что такое Span<T> в C# и когда он действительно ускоряет ваш код?"
description: "Span<T> помогает избегать временных копий и выделений памяти при разборе и форматировании. Время жизни, владение и измерение производительности."
pubDate: 2026-06-20
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "ru"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` — представление непрерывной памяти фиксированной длины: массива, стекового буфера или неуправляемой памяти с корректно обеспеченным временем жизни. `ReadOnlySpan<T>` допускает только чтение через представление. Строки предоставляют `ReadOnlySpan<char>`, а не изменяемый `Span<char>`.

Создание представления само по себе не выделяет и не передаёт владение исходным хранилищем. Это не делает всю операцию свободной от выделений памяти и не гарантирует ускорение.

**Исправление — 2 ноября 2026 года:** удалены неподтверждённые замеры и обещание универсального ускорения. Исправлены тип UTF-8-литерала, ограничения возврата и описание выделений памяти. Примеры проверены с SDK 10.0.302 и C# 14 без бенчмарка производительности.

## Избежать временных подстрок

Парсеры, принимающие Span, могут исключить промежуточные строки. Этот пример разбирает точный формат без отдельных подстрок года, месяца и дня:

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` проверяет дату и выбрасывает исключение при неверном вводе. Для ожидаемых ошибок используйте `TryParseExact`. Отдельные вызовы `int.Parse(input.Slice(...))` сами по себе не проверяют разделители и календарную корректность.

## Ограниченный временный буфер

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

Буфер исключает промежуточный массив символов, но создание итоговой `string` всё ещё выделяет память. Массив байтов для сравнения тоже выделяется: он поясняет значения и не является бенчмарком. `"GET"u8` имеет тип `ReadOnlySpan<byte>`.

Используйте небольшой ограниченный `stackalloc`. Большие или повторные выделения в цикле могут исчерпать стек. Не берите размер из непроверенного запроса; для больших данных нужны массивы или правильно управляемые буферы из пула.

## Общая память и время жизни

Срезы не копируют элементы. Span на массив можно вернуть, если память остаётся действительной; Span на локальный стековый буфер не может покинуть метод. Поля Span допустимы в другом `ref struct`, но не в обычном классе или структуре. С C# 13 ref-struct-локальные переменные допустимы в async-методах, если не пересекают `await`; для пересечения используйте `Memory<T>`.

`ReadOnlySpan<T>` не замораживает буфер. При использовании `CollectionsMarshal.AsSpan(list)` нельзя добавлять и удалять элементы, даже при свободной ёмкости списка.

## Измерять конкретное улучшение

Ищите устранимые копии и выделения: подстроки, скопированные срезы, временные массивы форматирования. Обычный цикл по массиву или списку уже может быть хорошо оптимизирован. Устранение проверок границ и скорость зависят от runtime и нагрузки; фиксированный множитель ненадёжен.

Измеряйте эквивалентную работу в Release на развёрнутом runtime с характерными данными. Вынесите подготовку из измерения, учитывайте выделения и сохраняйте код с выводом. Новые замеры скорости здесь не приводятся.

Базовые неявные преобразования массивов в Span существовали до C# 14. C# 14 вышел с .NET 10 и расширил языковую интеграцию. `allows ref struct` из C# 13 применим лишь к явно поддерживающим его обобщённым API.

Для выбора владения см. [List, Span и ReadOnlySpan](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/); для async-хранения — [ReadOnlyMemory из массива](/ru/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/).

## Источники

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
