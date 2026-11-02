---
title: "C# 13: 認識される任意のコレクション型で params コレクションを使う"
description: "C# 13 は配列以外のコレクションにも params を許可します。要素引数、通常形式と展開形式、対応条件、割り当てを解説。"
pubDate: 2025-01-02
updatedDate: 2026-11-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2025/01/csharp-13-params-collections"
translatedBy: "claude"
translationDate: 2026-05-01
---

C# 13 は `params` の対象を 1 次元配列から対応するコレクション型へ広げました。展開形式で渡すのは個々の**要素**であり、可変個の Span ではありません。

**訂正 — 2026 年 11 月 2 日：** 要素と Span の説明、およびコレクションの条件を修正しました。通常の `IEnumerable<T>` 引数にリストを渡すことは C# 13 より前から可能です。両サンプルは SDK 10.0.302、`LangVersion` 13 で確認しました。

## Span 引数

```csharp
using System;

Print(1, 2, 3); // Expanded form: three int elements.
int[] data = { 4, 5 };
Print(data);    // Normal form: an existing buffer.

static void Print(params ReadOnlySpan<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

通常形式は引数型に変換できる既存の値を渡します。展開形式は要素を渡し、コンパイラーがコレクションを構築します。`ReadOnlySpan<T>` は適切な呼び出しで配列の割り当てを避けられますが、すべての型と呼び出しで割り当てがなくなる保証はありません。

## 対応するコレクション

`Span<T>`、`ReadOnlySpan<T>`、対応するジェネリックコレクションインターフェイス、コレクション式に対応した builder 型などを使用できます。構築可能なコレクションには、必要なアクセス可能な引数なしコンストラクター、適切なインスタンス `Add` メソッド、列挙対応が必要です。`IEnumerable<T>` と任意の `Add` メソッドだけでは不十分です。

インターフェイスには `IEnumerable<T>`、`IReadOnlyCollection<T>`、`IReadOnlyList<T>`、`ICollection<T>`、`IList<T>` があります。

```csharp
using System;
using System.Collections.Generic;

var values = new List<int> { 1, 2, 3 };
Print(values);  // Normal form.
Print(4, 5, 6); // Expanded form: enabled by params collections in C# 13.

static void Print(params IEnumerable<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

最初の呼び出しは、`params` のない `IEnumerable<int>` 引数なら以前から可能でした。C# 13 はこの型に `Print(4, 5, 6)` という展開形式を追加します。そのためのコレクション生成はメモリを割り当てる場合があります。

`params` は最後の引数に置き、既定値や `ref`、`in`、`out` と組み合わせません。params コレクションのオーバーロード追加は、利用側の再コンパイル時に解決結果を変える可能性があります。実際の呼び出しを確認してください。

所有とビューの違いは [List、Span、ReadOnlySpan の比較](/ja/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)を参照してください。

## 出典

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
