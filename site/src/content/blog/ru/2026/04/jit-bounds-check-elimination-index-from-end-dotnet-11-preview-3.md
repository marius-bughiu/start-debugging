---
title: "RyuJIT обрезает больше bounds checks в .NET 11 Preview 3: index-from-end и i + константа"
description: ".NET 11 Preview 3 учит RyuJIT убирать избыточные bounds checks в последовательных index-from-end обращениях и в паттернах i + константа < length, снижая давление branch в плотных циклах."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "ru"
translationOf: "2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Bounds check elimination - та оптимизация JIT, которая тихо решает, насколько быстр большой кусок .NET кода. Каждое `array[i]` и `span[i]` в managed-коде несёт неявный compare-and-branch, и когда RyuJIT может доказать, что индекс в диапазоне, этот branch уходит. .NET 11 Preview 3 расширяет это доказательство на два распространённых паттерна, которые раньше всё равно платили за check.

Обе смены задокументированы в [release notes рантайма](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) и отмечены в [анонсе .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) от 14 апреля 2026.

## Подряд идущее обращение index-from-end

Оператор index-from-end `^1`, `^2`, введённый в C# 8, - синтаксический сахар для `Length - 1`, `Length - 2`. JIT давно уже мог элиминировать bounds check на первом таком обращении, но второе обращение сразу за ним часто рассматривалось независимо и вынуждало избыточный compare-and-branch.

В .NET 11 Preview 3 range analysis переиспользует доказательство length между последовательными index-from-end обращениями:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

Если вы дизасемблируете `TailSum` в [ASM viewer Rider 2026.1](https://blog.jetbrains.com/dotnet/), видно, как вторая пара `cmp`/`ja` просто исчезает. Код, обходящий хвост буфера, ring-buffer accessors, парсеры, подглядывающие последний токен, компараторы фиксированного окна - все получают выгоду без изменения исходников.

## Циклы `i + константа < length`

Второе улучшение целится в паттерн, постоянно встречающийся в численном и парсящем коде. Цикл stride-2 выглядел нормально на бумаге, но всё ещё платил bounds check на втором обращении:

```csharp
static int SumPairs(ReadOnlySpan<int> buffer)
{
    int sum = 0;
    for (int i = 0; i + 1 < buffer.Length; i += 2)
    {
        // buffer[i] is trivially safe, but buffer[i + 1] used to
        // get its own bounds check, even though the loop condition
        // already proved it.
        sum += buffer[i] + buffer[i + 1];
    }
    return sum;
}
```

Условие цикла `i + 1 < buffer.Length` уже доказывает, что `buffer[i + 1]` в диапазоне, но RyuJIT раньше обрабатывал два обращения независимо. Preview 3 учит анализ рассуждать про индекс плюс маленькую константу против length, так что и `buffer[i]`, и `buffer[i + 1]` компилируются в обычный load.

Та же перепись применима к `i + 2`, `i + 3` и так далее, пока константный offset совпадает с тем, что гарантирует условие цикла. Расширьте условие цикла до `i + 3 < buffer.Length`, и внутренний цикл stride-4 становится bounds-check-free по всем четырём обращениям.

## Почему маленькие branch суммируются

Один bounds check стоит меньше наносекунды на современных CPU. Реальное давление второго порядка: branch-слот, который он расходует, решения loop-unrolling, которые он блокирует, возможности векторизации, которые он разбивает. Когда RyuJIT доказывает, что весь внутренний цикл bounds-safe, он свободен разворачиваться агрессивнее и отдавать блок auto-векторизатору. Вот где микро-победа 1% на бумаге превращается в улучшение 10-20% на настоящем численном ядре.

## Попробовать сегодня

Ни одна оптимизация не требует feature flag. Запустите любой .NET 11 Preview 3 SDK, и они включаются автоматически. Установите `DOTNET_JitDisasm=TailSum`, чтобы дампить сгенерированный код, запустите один раз на .NET 10 и один на Preview 3, и сравните. Если поддерживаете hot loops над массивами или span, особенно что угодно, что заглядывает в конец буфера или идёт фиксированным stride, это бесплатный speedup, ждущий в Preview 3.
