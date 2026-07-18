---
title: "C# 15 の拡張インデクサーが .NET 11 Preview 6 で拡張メンバーを完成させる"
description: "拡張インデクサーが .NET 11 Preview 6 に登場し、自分が管理していない型に this[...] アクセスを追加できるようになりました。C# 14 のメソッドとプロパティから始まった拡張メンバーの物語を完成させます。"
pubDate: 2026-07-18
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "extension-members"
lang: "ja"
translationOf: "2026/07/csharp-15-extension-indexers-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-18
---

.NET 11 Preview 6 は 2026-07-14 にリリースされ、リリースノートの C# セクションには拡張メンバーをついに完成したものに感じさせる要素が隠れています。それが拡張インデクサーです。拡張メソッドは C# 3.0 から存在し、拡張プロパティは [C# 14 の拡張ブロック](/ja/2026/06/how-to-declare-extension-properties-in-csharp-14/)とともに登場しました。そして今では、自分が管理していない型に `this[...]` アクセスを追加できます。

## これまで欠けていたもの

これまで明白な回避策は、普通の拡張メソッドでした。`Index` を理解するインデクサーを持たない `IReadOnlyList<T>` に対して末尾からのインデックスのセマンティクスが欲しければ、次のように書いていました。

```csharp
public static class ReadOnlyListExtensions
{
    public static T At<T>(this IReadOnlyList<T> list, Index index)
        => list[index.GetOffset(list.Count)];
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log.At(^1));   // done
Console.WriteLine(log.At(^2));   // work
```

これは動作しますが、呼び出し側は他のあらゆるリスト風の型が提供する `log[^1]` 構文ではなく `log.At(^1)` と読めてしまいます。角かっこ記法を失い、リストパターンでもそれを失います。

## 拡張インデクサー版

C# 15 では、インスタンスインデクサーを宣言するのとまったく同じように、`extension` ブロックの中でインデクサーを宣言できます。

```csharp
public static class ReadOnlyListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public T this[Index index] => list[index.GetOffset(list.Count)];
    }
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log[^1]);   // done
Console.WriteLine(log[^2]);   // work
```

`extension<T>(IReadOnlyList<T> list)` というヘッダーで捕捉されたレシーバーは本体の中でスコープに入っているため、インデクサーは直接 `list` に転送します。呼び出し側は本物のインデクサー構文を使うようになり、コンパイラーがそれをインデクサーとして扱うため、組み込みのものと同じようにリストパターンや範囲式に参加します。

拡張インデクサーは、パラメーターが 1 つで読み取り専用の形に限られません。複数のパラメーターと `get` および `set` アクセサーをサポートするので、2 次元のルックアップをフラットなバッキングストアに射影したり、メソッドベースのアクセスしか提供しない型の上に書き込み可能なビューを公開したりできます。

## 有効化する方法

これはまだプレビューの言語機能なので、既定の言語バージョンでは有効になりません。次を `.csproj` に追加してください。

```xml
<LangVersion>preview</LangVersion>
```

拡張インデクサーは、古典的な 3 種類のメンバーのうち拡張ブロックに到達する最後のものです。つまりメンタルモデルはこれで統一されます。メソッド、プロパティ、インデクサーはすべて `extension(...)` の中で同じように宣言します。欠けているインデクサーを補うためにラッパー型やぎこちない `.At()` ヘルパーに頼ってきたなら、Preview 6 はそれらを削除できるリリースです。詳しい解説は [Preview 6 リリースノートの C# セクション](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/csharp.md)を参照してください。
