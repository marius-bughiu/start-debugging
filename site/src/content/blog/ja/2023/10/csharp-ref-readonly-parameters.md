---
title: "C# ref readonly パラメーター"
description: "C# の ref readonly 修飾子は、読み取り専用の参照を渡すより透明性の高い方法を提供します。in 修飾子に対して、より厳しい制約と呼び出し側からの見えやすさをどう改善するかを解説します。"
pubDate: 2023-10-28
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/10/csharp-ref-readonly-parameters"
translatedBy: "claude"
translationDate: 2026-05-01
---
`ref readonly` 修飾子を使うと、読み取り専用の参照をメソッドに渡す方法をより透明にできます。C# では 7.2 以降、`in` 修飾子で readonly な参照を渡すことはすでに可能でしたが、その構文にはいくつかの制限、というよりも制約が少なすぎるという問題がありました。

では、新しい修飾子はどう動くのでしょうか。次のメソッドシグネチャを考えてみましょう。

```cs
void FooRef(ref readonly int bar) { }
```

整数の変数や値を単に渡してこのメソッドを呼び出すと、コンパイラーの**警告**が出ます。これはあくまで警告で、実装上のあいまいさを指摘しているだけなので、それでも構わないなら、コードはそのまま動きます。

```cs
var x = 42;

FooRef(x);
FooRef(42);
```

-   `FooRef(x)` は警告 CS9192: Argument 1 should be passed with 'ref' or 'in' keyword をトリガーします
-   `FooRef(42)` は警告 CS9193: Argument 1 should be a variable because it is passed to a 'ref readonly' parameter をトリガーします

ひとつずつ見ていきましょう。

## `FooRef(x)`: `ref` または `in` を使う

これは `in` 修飾子に対する改善点のひとつです。`ref readonly` は、値が参照として渡されていることを呼び出し側に対して明示します。`in` ではこれが呼び出し側から見えず、混乱を招くことがありました。

CS9192 を直すには、呼び出しを `FooRef(ref x)` または `FooRef(in x)` のように明示的に書き換えるだけです。この 2 つの注釈はほぼ等価で、主な違いは、`in` のほうが寛容で代入できない値も渡せるのに対し、`ref` は代入可能な変数を必要とする点です。

たとえば次のとおりです。

```cs
readonly int y = 43;

FooRef(in y);
FooRef(ref y);
```

`FooRef(in y)` は問題なく動きますが、`FooRef(ref y)` では「ref の値は代入可能な変数でなければならない」というコンパイラーエラーが出ます。

## `FooRef(42)`: 受け付けるのは変数のみ

こちらが、`ref readonly` が `in` に対して持つもうひとつの改善点です。rvalue、つまり場所を持たない値を渡そうとした時点で文句を言うようになります。これは上の警告と表裏一体で、`FooRef(ref 42)` を試すと、即座に CS1510: A ref or out value must be an assignable variable のコンパイラーエラーが出ます。
