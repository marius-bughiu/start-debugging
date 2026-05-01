---
title: "Rendimiento en .NET: ToList vs ToArray"
description: ".NET 9 mejora considerablemente el rendimiento de ToArray usando InlineArray, haciéndolo más rápido y eficiente en memoria que ToList. Mira los benchmarks comparando .NET 8 vs .NET 9."
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-9"
  - "performance"
lang: "es"
translationOf: "2025/01/net-performance-tolist-vs-toarray"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 9 trae mejoras significativas al método `ToArray` de LINQ, tanto en velocidad como en asignación de memoria. Para conseguirlo, la nueva implementación aprovecha funciones del runtime como `InlineArray` para reducir notablemente las asignaciones de memoria y mejorar el rendimiento, especialmente al trabajar con un `IEnumerable<T>` de longitud desconocida. Si te interesa la implementación, puedes [revisar el PR en GitHub](https://github.com/dotnet/runtime/pull/96570).

## .NET 8 vs .NET 9

Primero, veamos la mejora de rendimiento de `ToArray` entre .NET 8 y .NET 9:

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

Aunque los resultados varían un poco según el número de elementos en el iterador, sigues obteniendo hasta un 38% menos de tiempo de CPU y un asombroso 57% menos de memoria asignada. ¡Bastante bien!

## ToList vs ToArray

Tradicionalmente `ToList` era más rápido al lidiar con colecciones de tamaño desconocido porque se ahorraba esa asignación final de arreglo, mientras que `ToArray` era más eficiente en uso de memoria. A partir de .NET 9 ya no es así, ya que `ToArray` resulta más eficiente desde ambas perspectivas.

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

En conjunto, hablamos de una diferencia de velocidad del 10 al 30% y alrededor de un 60% menos de memoria asignada, según la cantidad de elementos.

## Cómo ejecutar el benchmark

Si quieres, puedes ejecutar este benchmark tú mismo usando `BenchmarkDotNet`.

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
