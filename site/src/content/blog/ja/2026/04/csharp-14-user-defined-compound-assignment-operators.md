---
title: "C# 14 のユーザー定義複合代入演算子: 余分なアロケーションなしの in-place +="
description: "C# 14 では +=、-=、*= などをレシーバーを in-place で変更する void インスタンスメソッドとしてオーバーロードでき、BigInteger 風バッファやテンソルのような大きな値ホルダーのアロケーションを削減します。"
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
lang: "ja"
translationOf: "2026/04/csharp-14-user-defined-compound-assignment-operators"
translatedBy: "claude"
translationDate: 2026-04-24
---

C# 14 のより静かな追加事項のひとつが、ようやく言語リファレンスに舗装されつつあります: ユーザー定義の複合代入演算子です。.NET 10 までは、カスタム型に `x += y` と書くと常に `x = x + y` にコンパイルされ、つまり呼び出し側が古いものを捨てようとしていても `operator +` は新しいインスタンスをアロケートして返さなければなりませんでした。C# 14 では、レシーバーを in-place で変更する `void` インスタンスメソッドとして `+=` を直接オーバーロードできるようになりました。

動機はシンプルです: 多くのデータを保持する型 (`BigInteger` 風のバッファー、テンソル、プールされたバイトアキュムレーター) では、新しい宛先を作り、それを歩き、メモリをコピーすることが各 `+=` の高価な部分です。代入後に元の値が使われないなら、そのコピーは純粋な無駄です。[機能仕様](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) はこれを明示しています。

## 新しい演算子の宣言方法

C# 14 の複合代入演算子は静的ではありません。単一のパラメーターを取り、`void` を返し、インスタンス上に存在します:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

コンパイラーはインスタンスメソッドを `op_AdditionAssignment` という名前で発行します。呼び出し側が `acc += 5` と書いたとき、言語はインスタンス演算子があればそれを優先し、なければ古い `x = x + y` 書き換えがフォールバックとして残ります。つまり既存コードはコンパイルし続け、`+` のオーバーロードを壊さずに後から `+=` のオーバーロードを追加できます。

## 重要になる場面

ペイオフは内部バッファーを所有する参照型と、変更可能なストレージ位置を介して使われる struct 型で現れます。素朴な `Matrix operator +(Matrix, Matrix)` はホットループ内の `m += other` 呼び出しごとに新しい行列をまるごとアロケートしなければなりません。インスタンス版は `this` に加算して何も返さなくて済みます:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

前置 `++` と `--` も `public void operator ++()` で同じパターンに従います。後置 `x++` は結果が使われるとき依然として静的バージョンを通ります。in-place 変更後にプリインクリメントの値を生成できないからです。

## 知っておく価値のあること

言語は `+` と `+=` の整合性を強制しないので、片方だけ出荷できます。LDM は [2025 年 4 月にこれを検討](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) し、必須ペアリングを見送りました。`checked` バリアントも同じように動きます: 通常版と並べて `public void operator checked +=(int y)` を宣言してください。`readonly` は struct で許可されていますが、仕様が指摘するように、メソッド全体の目的がインスタンスを変更することである以上、意味があることは稀です。

機能は C# 14 と .NET 10 で出荷され、Visual Studio 2026 または .NET 10 SDK で今日から使えます。大きなデータ値型を露出する既存のライブラリにとって、インスタンス `+=` を後付けするのは、このリリースで利用できる最も安価なパフォーマンス向上の 1 つです。完全な概要は [C# 14 の新機能](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14) をご覧ください。
