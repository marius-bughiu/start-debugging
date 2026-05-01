---
title: "C# 8.0 の null 合体代入 ??="
description: "キャッシュや条件付き代入などの実用的な例を交えて、C# 8.0 の null 合体代入演算子 (??=) の動作を学びます。"
pubDate: 2020-04-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2020/04/c-8-0-null-coalescing-assignment"
translatedBy: "claude"
translationDate: 2026-05-01
---
この演算子を使うと、左辺の値が null と評価された場合にのみ、右辺のオペランドの値を左辺のオペランドに代入できます。

ごく基本的な例を見てみましょう。

```cs
int? i = null;

i ??= 1;
i ??= 2;
```

上の例では null 許容の `int` 変数 `i` を宣言し、それに対して 2 回の null 合体代入を行います。最初の代入時に `i` は `null` と評価されるため、`i` には `1` が代入されます。次の代入時には `i` は `1` で、`null` ではないため、その代入はスキップされます。

予想どおり、右辺のオペランドの値は、左辺のオペランドが `null` の場合にのみ評価されます。

```cs
int? i = null;

i ??= Method1();
i ??= Method2(); // Method2 is never called because i != null
```

## ユースケース

この演算子は、特定の変数の値が設定されるまで複数の `if` 分岐をたどるような場面で、コードを簡潔かつ読みやすくするのに役立ちます。

その一例がキャッシュです。次の例では、キャッシュから取得しようとした後でも `user` がまだ null のときにのみ `GetUserFromServer` が呼び出されます。

```cs
var user = GetUserFromCache(userId);
user ??= GetUserFromServer(userId);
```
