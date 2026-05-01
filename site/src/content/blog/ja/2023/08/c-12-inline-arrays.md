---
title: "C# 12 インライン配列 (Inline arrays)"
description: "インライン配列を使うと、struct 型の中に固定サイズの配列を作成できます。インラインバッファーを持つそのような struct は、unsafe な固定サイズバッファーと同等のパフォーマンスを発揮します。インライン配列は主にランタイムチームや一部のライブラリ作者が、特定のシナリオでパフォーマンスを改善するために使うことを想定しています。多くの場合..."
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/08/c-12-inline-arrays"
translatedBy: "claude"
translationDate: 2026-05-01
---
インライン配列を使うと、`struct` 型の中に固定サイズの配列を作成できます。インラインバッファーを持つそのような struct は、unsafe な固定サイズバッファーと同等のパフォーマンスを発揮します。

インライン配列は主にランタイムチームや一部のライブラリ作者が、特定のシナリオでパフォーマンスを改善するために使うことを想定しています。多くの場合、自分でインライン配列を宣言することはなく、ランタイムが `Span<T>` や `ReadOnlySpan<T>` として公開しているものを通じて、間接的に使うことになるでしょう。

## インライン配列の宣言方法

struct を作成し、コンストラクター引数に配列の長さを取る `InlineArray` 属性で囲むことで、インライン配列を宣言できます。

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

注: プライベートメンバーの名前は何でも構いません。お好みなら `private int _abracadabra`; でもよいです。重要なのは型で、これによって配列の型が決まります。

## InlineArray の使い方

インライン配列は、ほかの配列とほぼ同じように使えますが、いくつか小さな違いがあります。例を見てみましょう。

```cs
var arr = new MyInlineArray();

for (int i = 0; i < 10; i++)
{
    arr[i] = i;
}

foreach (var item in arr)
{
    Console.WriteLine(item);
}
```

最初に気づくのは、初期化時にサイズを指定していない点です。インライン配列はサイズ固定で、その長さは `struct` に付けた `InlineArray` 属性で決まります。それ以外は普通の配列のように見えますが、実はもう少しあります。

### InlineArray には Length プロパティがない

上の `for` ループでは `arr.Length` ではなく `10` までイテレートしている点に気づいた方もいるかもしれません。インライン配列には、通常の配列のように公開された `Length` プロパティがないからです。

さらに変な点があります...

### InlineArray は IEnumerable を実装していない

そのため、インライン配列に対して `GetEnumerator` を呼び出すことはできません。最大の欠点は、インライン配列に対して LINQ を使えないことです。少なくとも現時点では、ですが、将来的に変わる可能性はあります。

`IEnumerable` を実装していないにもかかわらず、`foreach` ループの中では引き続き使用できます。

```cs
foreach (var item in arr) { }
```

同様に、スプレッド演算子をインライン配列と組み合わせて使うこともできます。

```cs
int[] m = [1, 2, 3, ..arr];
```
