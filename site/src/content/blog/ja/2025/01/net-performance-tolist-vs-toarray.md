---
title: ".NET のパフォーマンス: ToList vs ToArray"
description: ".NET 9 は InlineArray を活用して ToArray のパフォーマンスを大幅に改善し、ToList より高速かつメモリ効率の良いものにします。.NET 8 と .NET 9 を比較したベンチマークを参照ください。"
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-9"
  - "performance"
lang: "ja"
translationOf: "2025/01/net-performance-tolist-vs-toarray"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 9 は LINQ の `ToArray` メソッドに、速度・メモリ割り当ての両面で大きな改善をもたらします。新しい実装は、これを実現するために `InlineArray` のようなランタイム機能を活用し、特に長さの分からない `IEnumerable<T>` を扱うときに、メモリ割り当てを大幅に減らし速度を高めます。実装に興味があれば、[GitHub の PR](https://github.com/dotnet/runtime/pull/96570) をご覧ください。

## .NET 8 vs .NET 9

まず、`ToArray` の .NET 8 と .NET 9 でのパフォーマンス改善を見てみましょう。

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

イテレーターの要素数によって結果は多少変わりますが、それでも CPU 時間で最大 38%、割り当てメモリでは驚異の 57% の削減が得られます。なかなかですね!

## ToList vs ToArray

従来、サイズの分からないコレクションを扱う際には、`ToList` のほうが最後の配列割り当てを省ける分だけ速く、`ToArray` はメモリ使用量の面で効率的でした。.NET 9 以降、それはもう当てはまりません。`ToArray` は両方の観点で効率的になっています。

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

全体としては、要素数によって 10 〜 30% の速度差があり、割り当てメモリは約 60% 少なくなっています。

## ベンチマークを実行する

`BenchmarkDotNet` を使えば、このベンチマークを自分で実行することもできます。

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
