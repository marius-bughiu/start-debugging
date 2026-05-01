---
title: "Desempenho no .NET: ToList vs ToArray"
description: "O .NET 9 melhora significativamente o desempenho de ToArray usando InlineArray, tornando-o mais rápido e eficiente em memória do que ToList. Veja benchmarks comparando .NET 8 vs .NET 9."
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-9"
  - "performance"
lang: "pt-br"
translationOf: "2025/01/net-performance-tolist-vs-toarray"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 9 traz melhorias significativas para o método `ToArray` do LINQ, tanto em velocidade quanto em alocação de memória. Para conseguir isso, a nova implementação faz uso de recursos do runtime como o `InlineArray` para reduzir bastante as alocações de memória e melhorar o desempenho, especialmente ao lidar com um `IEnumerable<T>` de tamanho desconhecido. Se você tiver curiosidade sobre a implementação, [confira o PR no GitHub](https://github.com/dotnet/runtime/pull/96570).

## .NET 8 vs .NET 9

Primeiro, vamos olhar a melhoria de desempenho de `ToArray` entre o .NET 8 e o .NET 9:

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

Embora os resultados variem um pouco conforme a quantidade de itens no iterador, ainda há uma redução de até 38% no tempo de CPU e impressionantes 57% na memória alocada. Bastante bom!

## ToList vs ToArray

Tradicionalmente, `ToList` era mais rápido ao lidar com coleções de tamanho desconhecido porque pulava a alocação final do array, enquanto `ToArray` era mais eficiente em uso de memória. A partir do .NET 9, esse não é mais o caso, com `ToArray` se mostrando mais eficiente nas duas frentes.

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

No geral, estamos falando de uma diferença de velocidade de 10 a 30% e cerca de 60% menos memória alocada, dependendo do número de elementos.

## Como rodar o benchmark

Se quiser, você pode executar este benchmark por conta própria usando o `BenchmarkDotNet`.

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
