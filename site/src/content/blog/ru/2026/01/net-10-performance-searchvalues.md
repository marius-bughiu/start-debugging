---
title: "Производительность .NET 10: SearchValues"
description: "Используйте SearchValues в .NET 10 для высокопроизводительного поиска по нескольким строкам. Заменяет циклы foreach на сопоставление, ускоренное SIMD, с алгоритмами Aho-Corasick и Teddy."
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/net-10-performance-searchvalues"
translatedBy: "claude"
translationDate: 2026-05-01
---
В .NET 8 Microsoft представила `SearchValues<T>` -- специализированный тип, оптимизирующий поиск _набора_ значений (например, байтов или символов) внутри span. Он векторизовал поиск, делая его значительно быстрее, чем `IndexOfAny`.

В .NET 10 эта возможность расширена и на строки. `SearchValues<string>` позволяет искать несколько подстрок одновременно с впечатляющей производительностью.

## Сценарий использования: разбор и фильтрация

Представьте, что вы пишете парсер или санитайзер, которому нужно проверить, содержит ли текст какое-либо слово или токен из определённого списка запрещённых.

**Старый способ (медленный)**

```cs
private static readonly string[] Forbidden = { "drop", "delete", "truncate" };

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    foreach (var word in Forbidden)
    {
        if (input.Contains(word, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

Это O(N \* M), где N -- длина входной строки, а M -- количество слов. Строка сканируется многократно.

## Новый способ: SearchValues

С .NET 10 вы можете заранее вычислить стратегию поиска.

```cs
using System.Buffers;

// 1. Create the optimized searcher (do this once, statically)
private static readonly SearchValues<string> SqlTokens = 
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    // 2. Search for ANY of them in one pass
    return input.ContainsAny(SqlTokens);
}
```

## Влияние на производительность

Внутри `SearchValues.Create` анализирует шаблоны.

-   Если у них есть общие префиксы, строится структура наподобие trie.
-   Используются алгоритмы Aho-Corasick или Teddy в зависимости от плотности шаблона.
-   Применяется SIMD (AVX-512) для параллельного сопоставления нескольких символов.

Для набора из 10--20 ключевых слов `SearchValues` может быть **в 50 раз быстрее**, чем цикл или Regex.

## Поиск позиции

Вы не ограничены булевой проверкой. Вы можете найти, _где_ произошло совпадение:

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## Итог

`SearchValues<string>` в .NET 10 открывает высокопроизводительный поиск по тексту широкому кругу разработчиков без внешних библиотек. Если вы занимаетесь обработкой текста, анализом журналов или фильтрацией для безопасности, немедленно заменяйте циклы `foreach` на `SearchValues`.
