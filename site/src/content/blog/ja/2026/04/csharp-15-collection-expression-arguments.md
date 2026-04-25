---
title: "C# 15 のコレクション式引数: with(...) でコンストラクタをインラインで渡す"
description: "C# 15 はコレクション式に with(...) 要素を追加し、容量、コンパレーター、その他のコンストラクタ引数を初期化子内で直接渡せるようにします。"
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
lang: "ja"
translationOf: "2026/04/csharp-15-collection-expression-arguments"
translatedBy: "claude"
translationDate: 2026-04-25
---

コレクション式は C# 12 で登場し、それ以降新機能を吸収してきました。[.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview) と共に出荷される C# 15 は、欠けていたピースを追加します。コレクションのコンストラクタやファクトリメソッドへの引数を、式の先頭に置かれる `with(...)` 要素で渡せるようになりました。

## なぜこれが重要か

C# 15 以前のコレクション式は、対象の型を推論しそのデフォルトコンストラクタを呼び出していました。大文字小文字を区別しない `HashSet<string>` や、既知の容量にあらかじめサイズが設定された `List<T>` が必要な場合、従来の初期化子か 2 ステップのセットアップに戻らねばなりませんでした。

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

どちらのパターンも、コレクション式が設計された簡潔な流れを壊します。

## `with(...)` でインラインのコンストラクタ引数

C# 15 では代わりにこう書けます。

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

`with(...)` 要素は最初に現れる必要があります。その後、式の残りは他のコレクション式と全く同じように動作します。リテラル、スプレッド、ネストした式はすべて通常通り合成されます。

## 辞書も同じ扱いを受ける

この機能は `Dictionary<TKey, TValue>` で本領を発揮します。ここではコンパレーターが一般的ですが、これまではコレクション式から完全に離れることを強いられていました。

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

`with(...)` がなければ、コレクション式を介してコンパレーターを渡すことは全くできませんでした。唯一の選択肢はコンストラクタ呼び出しの後に手動で追加することでした。

## 知っておくべき制約

留意すべきいくつかのルール:

- `with(...)` は式の **最初の** 要素でなければなりません。
- 配列や span 型 (`Span<T>`、`ReadOnlySpan<T>`) ではサポートされません。それらには構成パラメータを伴うコンストラクタがないからです。
- 引数は `dynamic` 型を持てません。

## 自然な進化

C# 12 は構文を与えてくれました。C# 13 は `params` を拡張してコレクション式を受け入れるようにしました。C# 14 は暗黙の span 変換を広げました。今や C# 15 はコレクション式を放棄する最後の一般的な理由 -- コンストラクタの設定 -- を取り除きます。すでに [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) 以降にいるなら、プロジェクトファイルに `<LangVersion>preview</LangVersion>` を入れて今日これを試せます。

完全な仕様: [Collection expression arguments proposal](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md)。
