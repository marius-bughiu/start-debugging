---
title: "C# 12 コレクション式 (Collection expressions)"
description: "C# 12 では、配列を作るための新しい簡潔な構文が導入されました。次のような形です。重要な点として、配列の型は明示的に指定する必要があるため、変数宣言に var は使えません。同様に、Span<int> を作りたい場合は次のようにできます。多次元配列 この簡潔な構文の利点は..."
pubDate: 2023-08-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/08/c-12-collection-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 12 では、配列を作るための新しい簡潔な構文が導入されました。次のような形です。

```cs
int[] foo = [1, 2, 3];
```

重要な点として、配列の型は明示的に指定する必要があるため、変数宣言に `var` は使えません。

同様に、`Span<int>` を作りたい場合は次のようにできます。

```cs
Span<int> bar = [1, 2, 3];
```

## 多次元配列

この簡潔な構文の利点は、多次元配列を定義するときにさらに際立ちます。2 次元配列を例に見てみましょう。新しい構文を使わない場合の定義はこうです。

```cs
int[][] _2d = new int[][] { new int[] { 1, 2, 3 }, new int[] { 4, 5, 6 }, new int[] { 7, 8, 9 } };
```

新しい構文ではこうなります。

```cs
int[][] _2d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
```

ずっとシンプルで直感的ですよね。

## スプレッド演算子による配列の結合

新しい構文と一緒に、新しいスプレッド演算子 `..` も導入されました。これは適用された引数を、その要素に展開して置き換えるもので、コレクションどうしを結合するのに使えます。いくつか例を見てみましょう。

まずは一番シンプルな例、複数の配列を 1 つに結合する場合です。

```cs
int[] a1 = [1, 2, 3];
int[] a2 = [4, 5, 6];
int[] a3 = [7, 8, 9];

int[] merged = [..a1, ..a2, ..a3];
```

スプレッド演算子は任意の `IEnumerable` に適用でき、異なる `IEnumerable` を 1 つのコレクションに結合するのにも使えます。

```cs
int[] a1 = [1, 2, 3];
List<int> a2 = [4, 5, 6];
Span<int> a3 = [7, 8, 9];

Collection<int> merged = [..a1, ..a2, ..a3];
```

個別の要素と組み合わせて、既存のコレクションの両端に要素を追加した新しいコレクションを作ることもできます。

```cs
int[] merged = [1, 2, 3, ..a2, 10, 11, 12];
```

### Error CS9176

> Error CS9176 There is no target type for the collection expression.

コレクション式では `var` を使えません。変数の型を必ず明示的に指定する必要があります。例:

```cs
// Wrong - triggers CS9176
var foo = [1, 2, 3];

// Correct
int[] foo = [1, 2, 3];
```

### Error CS0029

> Error CS0029 Cannot implicitly convert type 'int\[\]' to 'System.Index'

これは、サポートされていない従来のコレクション初期化子の構文の中でスプレッド演算子を使おうとしたときに発生することがあります。スプレッド演算子を使うときは、新しい簡潔な構文を使ってください。

```cs
// Wrong - triggers CS0029
var a = new List<int> { 1, 2, 3, ..a1, 4, 5 };

// Correct
List<int> a = [1, 2, 3, .. a1, 4, 5];
```

### Error CS8652

> Error CS8652 The feature 'collection expressions' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

> Error CS8652 The feature 'collection literals' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

これらのエラーは、プロジェクトがまだ C# 12 を使っておらず、新しい言語機能を利用できないことを意味します。C# 12 に切り替えたいけれどやり方がわからない場合は、[プロジェクトを C# 12 に切り替えるガイド](/2023/06/how-to-switch-to-c-12/) をご覧ください。
