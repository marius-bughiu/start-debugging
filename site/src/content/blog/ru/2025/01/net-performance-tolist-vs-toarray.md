---
title: "Производительность .NET: ToList vs ToArray"
description: ".NET 9 значительно улучшает производительность ToArray за счёт InlineArray, делая его быстрее и экономнее по памяти, чем ToList. Смотрите бенчмарки сравнения .NET 8 и .NET 9."
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-9"
  - "performance"
lang: "ru"
translationOf: "2025/01/net-performance-tolist-vs-toarray"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 9 приносит существенные улучшения в метод `ToArray` из LINQ — как по скорости, так и по выделению памяти. Чтобы этого добиться, новая реализация использует возможности среды выполнения, такие как `InlineArray`, что значительно сокращает выделения памяти и повышает скорость, особенно при работе с `IEnumerable<T>` неизвестной длины. Если вам интересна реализация, [посмотрите PR на GitHub](https://github.com/dotnet/runtime/pull/96570).

## .NET 8 vs .NET 9

Сначала взглянем на улучшение производительности `ToArray` между .NET 8 и .NET 9:

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToArray | .NET 8.0 | 10     |     115.61 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.62 |     104 B |        0.41 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 1000   |   3,209.52 ns |  1.00 |    8536 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.82 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 100000 | 545,642.89 ns |  1.00 |  925132 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.67 |  400148 B |        0.43 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

Хотя результаты немного варьируются в зависимости от количества элементов в итераторе, всё равно вы получаете до 38% меньше времени CPU и впечатляющие 57% меньше выделенной памяти. Очень неплохо!

## ToList vs ToArray

Традиционно `ToList` был быстрее при работе с коллекциями неизвестного размера, потому что пропускал финальное выделение массива, тогда как `ToArray` был эффективнее по памяти. Начиная с .NET 9 это уже не так: `ToArray` оказывается эффективнее с обеих точек зрения.

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToList  | .NET 9.0 | 10     |      81.44 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.88 |     104 B |        0.40 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 1000   |   2,942.87 ns |  1.00 |    8464 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.89 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 100000 | 494,497.60 ns |  1.00 | 1049112 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.73 |  400148 B |        0.38 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

В целом речь идёт о разнице в скорости от 10 до 30% и примерно 60% меньшем выделении памяти, в зависимости от количества элементов.

## Запуск бенчмарка

При желании этот бенчмарк можно запустить самостоятельно с помощью `BenchmarkDotNet`.

```cs
[SimpleJob(RuntimeMoniker.Net80, baseline: true)]
[SimpleJob(RuntimeMoniker.Net90)]
[MemoryDiagnoser(false)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class Benchmarks
{
    [Params(10, 1000, 100000)]
    public int Count;

    [Benchmark]
    public List<int> ToList() => GetItems(Count).ToList();

    [Benchmark]
    public int[] ToArray() => GetItems(Count).ToArray();

    private IEnumerable<int> GetItems(int count)
    {
        for (int i = 0; i < count; i++)
        {
            yield return 1;
        }
    }
}
```
```cs
BenchmarkRunner.Run<Benchmarks>();
```
