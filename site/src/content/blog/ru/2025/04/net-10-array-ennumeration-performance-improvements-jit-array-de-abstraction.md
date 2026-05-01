---
title: ".NET 10: улучшения производительности перебора массивов (де-абстракция массивов в JIT)"
description: "В .NET 10 JIT-компилятор уменьшает накладные расходы при переборе массивов через интерфейсы. Смотрите бенчмарки .NET 9 vs .NET 10 с foreach, IEnumerable и условным анализом побега."
pubDate: 2025-04-06
tags:
  - "dotnet"
  - "dotnet-10"
  - "performance"
lang: "ru"
translationOf: "2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction"
translatedBy: "claude"
translationDate: 2026-05-01
---
В .NET 10 Preview 1 JIT-компилятор стал лучше оптимизировать использование массивов вместе с интерфейсами, особенно при обходе с помощью `foreach`. Это первый шаг к снижению дополнительных затрат, связанных с использованием перечислителей для прохода по массивам. Preview 2 продолжает эту работу, принося ещё больше улучшений.

Взгляните на следующий пример:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90)]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [Benchmark(Baseline = true)]
    public int Enumeration()
    {
        int sum = 0;
        foreach (int i in array) sum += i;
        return sum;
    }

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = array;
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

В первом методе тип массива известен на этапе компиляции, поэтому JIT может сгенерировать быстрый код. Во втором методе массив рассматривается как `IEnumerable<int>`, что скрывает фактический тип. Это добавляет дополнительную работу, например создание объекта и виртуальные вызовы методов. В .NET 9 это сильно сказывалось на производительности:

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

Благодаря дальнейшим улучшениям в .NET 10, таким как более качественное встраивание, более умное использование памяти и улучшенная обработка циклов, это лишнее выделение памяти исчезло, а производительность стала намного выше:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Цель — полностью устранить разрыв даже в более сложных случаях. Вот более жёсткий пример:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [MethodImpl(MethodImplOptions.NoInlining)]
    IEnumerable<int> GetOpaqueArray() => array;

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = GetOpaqueArray();
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

В этом случае метод возвращает `IEnumerable<int>`, не показывая, что это на самом деле массив. JIT не знает реального типа и поэтому не может оптимизировать так же хорошо. Однако с помощью PGO (Profile-Guided Optimization) JIT может предположить наиболее вероятный тип и создать более быструю ветку для случаев, когда предположение верно.

В .NET 9 JIT не мог разместить перечислитель на стеке. Это связано с так называемым "escape analysis" — анализом, который проверяет, может ли объект быть использован за пределами текущего метода. Если может, JIT действует осторожно и размещает его в куче. Но в .NET 10 появилась новая возможность — **условный анализ побега**. Он умнее в определении того, _когда_ объект всё-таки покидает метод. Если JIT видит, что объект уходит только по определённым путям (например, когда тип не такой, как ожидалось), он может создать отдельный быстрый путь, где объект остаётся на стеке.

Благодаря этому в .NET 10 мы получаем существенно лучшие результаты по сравнению с .NET 9:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

Как видно, .NET становится умнее в работе с перебором массивов, даже когда они скрыты за интерфейсами. Это даёт лучшую производительность и меньшее использование памяти, особенно в реальном коде, где такие шаблоны встречаются часто.
