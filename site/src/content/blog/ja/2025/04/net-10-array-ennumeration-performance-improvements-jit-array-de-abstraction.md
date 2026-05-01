---
title: ".NET 10: 配列の列挙パフォーマンス改善 (JIT による配列の脱抽象化)"
description: ".NET 10 では、JIT コンパイラーがインターフェース経由で配列を反復するオーバーヘッドを削減します。foreach、IEnumerable、条件付きエスケープ解析を使った .NET 9 と .NET 10 のベンチマーク比較を見てみましょう。"
pubDate: 2025-04-06
tags:
  - "dotnet"
  - "dotnet-10"
  - "performance"
lang: "ja"
translationOf: "2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 10 Preview 1 では、JIT コンパイラーがインターフェース経由で配列を扱う際の最適化、特に `foreach` を使った反復の最適化を改善しました。これは、列挙子を使って配列を回すときに発生する余分なコストを削減する第一歩でした。Preview 2 ではこの取り組みをさらに進め、より多くの改善が加わっています。

次の例を見てみましょう。

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

最初のメソッドでは、配列の型がコンパイル時に分かっているため、JIT は高速なコードを生成できます。2 番目のメソッドでは、配列が `IEnumerable<int>` として扱われ、実際の型が隠されています。これにより、オブジェクトの生成や仮想メソッド呼び出しといった余分な処理が増えます。.NET 9 では、これがパフォーマンスに大きな影響を与えていました。

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

.NET 10 では、よりよいインライン化、よりスマートなメモリ利用、改善されたループ処理などの追加の改良によって、この余分なアロケーションは消え、パフォーマンスは大幅に向上しました。

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

ゴールは、より複雑なケースでもこのギャップを完全に埋めることです。次は、もう少し難しい例です。

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

このケースでは、メソッドは実際には配列であることを明かさずに `IEnumerable<int>` を返します。JIT は実際の型を知らないため、十分に最適化できません。しかし PGO (Profile-Guided Optimization) を使えば、JIT は最も可能性の高い型を推測し、その推測が正しい場合に高速なパスを生成できます。

.NET 9 では、JIT は列挙子をスタックに置けませんでした。これは "escape analysis" と呼ばれる仕組みのためで、オブジェクトが現在のメソッドの外で使われる可能性があるかどうかを調べます。可能性があれば、JIT は安全側に倒してヒープに置きます。しかし .NET 10 には **条件付きエスケープ解析** という新機能があり、_いつ_ オブジェクトが脱出するのかをよりスマートに判断します。JIT が、特定の経路でだけオブジェクトが脱出する (たとえば期待した型でなかったとき) と判定できれば、オブジェクトをスタックに保ったままの高速パスを別途生成できます。

これにより、.NET 9 と比べて .NET 10 で大幅によい結果が得られます。

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

ご覧のとおり、.NET はインターフェースの背後に包まれていても、配列の反復処理をより賢く扱えるようになっています。これは、こうしたパターンが頻繁に登場する実世界のコードにおいて、優れたパフォーマンスとより少ないメモリ使用量につながります。
