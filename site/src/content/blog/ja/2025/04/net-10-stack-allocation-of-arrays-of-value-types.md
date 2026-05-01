---
title: ".NET 10: 値型の配列のスタック割り当て"
description: ".NET 10 では、JIT が値型の小さな固定サイズ配列をスタックに割り当てられるようになり、ヒープ割り当てを排除して .NET 9 と比べて最大 60% 高速なパフォーマンスを実現します。"
pubDate: 2025-04-12
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2025/04/net-10-stack-allocation-of-arrays-of-value-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 9 から、JIT コンパイラーはオブジェクトのメモリ割り当てをより賢く行うようになりました。オブジェクトが作成されたメソッドの終了後に使われないことを判別できれば、ヒープではなくスタックに配置できます。これはパフォーマンス上の大きな利点で、ガベージコレクションがそのオブジェクトを追跡する必要がなくなるからです。さらに、スタック割り当てによって JIT はより多くの最適化を適用できるようになり、たとえばオブジェクト全体を個々のフィールドや値に置き換えることもできます。これにより、参照型の利用がパフォーマンスの観点でかなり安価になります。

.NET 10 では、この機能が拡張され、値型の小さな固定サイズ配列も対象になりました。JIT は、配列がそれを保持するメソッドと同じ寿命でしか生きないと分かっている場合、これらの配列をスタックに割り当てます。

次の例を見てみましょう。

```cs
static void Sum()
{
    int[] numbers = {1, 2, 3};
    int sum = 0;

    for (int i = 0; i < numbers.Length; i++)
    {
        sum += numbers[i];
    }

    Console.WriteLine(sum);
}
```

ここで `numbers` 配列には 3 つの整数しか入っておらず、`Sum` メソッド内でのみ使用されています。JIT はコンパイル時にそのサイズとスコープを把握しているため、安全に配列をスタックに配置できます。つまりヒープ割り当てが発生せず、パフォーマンスが向上します。

## ベンチマーク

.NET 9 と .NET 10 を比較すると、上記のシナリオでは **ヒープに何も割り当てられなくなる** ことがはっきり分かります。これはパフォーマンスの大幅な向上にもつながり、計測したシナリオでは **.NET 10 が 60% 高速** になっています。

```clean
| Method        | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|-------------- |---------- |---------:|------:|-------:|----------:|------------:|
| AllocateArray | .NET 10.0 | 3.041 ns |  0.40 |      - |         - |        0.00 |
| AllocateArray | .NET 9.0  | 7.675 ns |  1.00 | 0.0067 |      56 B |        1.00 |
```

ベンチマークを自分で実行してみたい場合は、以下のコードを参考にしてください。

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayAllocationBenchmarks
{
    [Benchmark]
    public int AllocateArray()
    {
        int total = 0;

        int[] numbers = { 1, 2, 3, 4, 5, 6, 7 };
        for (int i = 0; i < numbers.Length; i++)
        {
            total += numbers[i];
        }

        return total;
    }
}

internal class Program
{
    static void Main(string[] args)
    {
        BenchmarkRunner.Run<ArrayAllocationBenchmarks>();
    }
}
```
