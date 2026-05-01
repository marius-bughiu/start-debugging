---
title: "C# 14: ラムダで修飾子付きパラメーターをシンプルに"
description: "C# 14 では、暗黙的に型付けされたラムダパラメーターに対して ref、out、in、scoped、ref readonly の各修飾子を使用できるようになり、パラメーターの型を明示的に宣言する必要がなくなります。"
pubDate: 2025-04-09
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2025/04/c-14-simplified-parameters-with-modifiers-in-lambdas"
translatedBy: "claude"
translationDate: 2026-05-01
---
ラムダ式は長年にわたって C# の中核的な機能であり、インライン関数やコールバックを簡潔に記述する手段として使われてきました。C# のラムダには、各パラメーターの型を指定する **明示的型付きパラメーター** と、コンテキストから型が推論される **暗黙的型付きパラメーター** があります。C# 14 より前は、ラムダで一部のパラメーター修飾子 (参照渡しや出力パラメーターなど) を使いたい場合、パラメーター型を明示的に宣言せざるを得ませんでした。そのため、こうした修飾子が必要なシナリオではラムダの構文がしばしば冗長になりがちでした。

C# 14 では、この制限を解消する新機能 **修飾子付きのシンプルなラムダパラメーター** が導入されます。この機能により、`ref`、`in`、`out`、`scoped`、`ref readonly` といった修飾子を、パラメーター型を明示的に書くことなくラムダ式で使用できます。簡単に言えば、これらの修飾子を「型なし」のラムダパラメーター (型が推論されるパラメーター) に付けられるようになり、特殊なパラメーター渡しを伴うラムダがより書きやすく読みやすくなります。

## C# 13 以前のラムダ

C# 13 およびそれ以前のすべてのバージョンでは、ラムダパラメーターは明示的型付きでも暗黙的型付きでもよかったのですが、パラメーター修飾子を使う際には注意点がありました。いずれかのラムダパラメーターに修飾子 (たとえば `out` や `ref`) が必要な場合、C# コンパイラーはそのラムダの **すべて** のパラメーターに対して明示的な型宣言を求めました。`ref`、`in`、`out`、`scoped`、`ref readonly` をラムダパラメーターに適用するには、そのパラメーターの型も書く必要があったのです。

たとえば、`out` パラメーターを持つデリゲート型を考えてみます。

```cs
// A delegate that tries to parse a string into T, returning true on success.
delegate bool TryParse<T>(string text, out T result);
```

C# 13 でこのデリゲートにラムダを代入したい場合、片方のパラメーターが `out` 修飾子を使っているため、両方のパラメーターの型を明示的に書く必要がありました。C# 13 で有効なラムダ代入は次のようになります。

```cs
// C# 13 and earlier: must explicitly specify types when using 'out'
TryParse<int> parseOld = (string text, out int result) => Int32.TryParse(text, out result);
```

ここでは `text` パラメーターに `string`、`result` パラメーターに `int` を明示的に書いています。型を省略しようとすると、コードはコンパイルできません。言い換えると、`(text, out result) => ...` のような形は C# 13 では **許可されていません**。`result` に付いた `out` のために、`result` の型 (この場合 `int`) を明示する必要があるからです。この要件は、ラムダのパラメーターリストにおける `ref`、`in`、`out`、`ref readonly`、`scoped` のいずれの修飾子にも適用されました。

## C# 14 のラムダパラメーター修飾子

C# 14 ではこの制限が取り除かれ、ラムダはより柔軟になります。パラメーターの型を明示的に指定することなく、ラムダパラメーターに修飾子を付けられるようになりました。コンパイラーは、ラムダが変換される対象のデリゲートや式ツリーの型といったコンテキストから型を推論しつつ、修飾子の使用も許可します。これにより、参照渡しや scoped パラメーターを伴うデリゲートや式を扱う際に、ボイラープレートが減り、コードが読みやすくなります。

**サポートされる修飾子:** C# 14 から、暗黙的に型付けされたラムダパラメーターに対して次の修飾子を使用できます。

-   `ref` -- 引数を参照渡しし、ラムダから呼び出し元の変数を読み書きできるようにします。
-   `out` -- 引数を出力用として参照渡しします。ラムダは戻る前にこのパラメーターに値を代入する必要があります。
-   `in` -- 引数を読み取り専用の参照として渡します。ラムダから値を読み取れますが、変更はできません。
-   `ref readonly` -- 読み取り専用の方法で参照渡しします (本質的には `in` に似ており、特定の値型シナリオ向けに導入されました)。
-   `scoped` -- パラメーター (典型的には `Span<T>` のような ref struct) が呼び出しのスコープに限定され、呼び出しを越えてキャプチャや保存ができないことを示します。

これらの修飾子は、これまではラムダ内でパラメーターを明示的に型付けした場合にのみ使用できました。これからは、型を書かずにラムダのパラメーターリストへ記述できます。

重要な注意点として、`params` 修飾子はこの新機能の対象に **含まれません**。ラムダに `params` パラメーター (可変長引数) がある場合、そのパラメーターの型は引き続き明示的に指定する必要があります。要するに、`params` はラムダにおいて従来どおり、明示的に型付けされたパラメーターリストを必要とします。

`TryParse<T>` デリゲートを使った先ほどの例に戻り、C# 14 がどのように構文を簡略化するかを見てみましょう。型名を省略しても `out` 修飾子を使い続けることができます。

```cs
// C# 14: type inference with 'out' parameter
TryParse<int> parseNew = (text, out result) => Int32.TryParse(text, out result);
```

このラムダは `TryParse<int>` に代入されているため、デリゲートの定義から `text` が `string`、`result` が `int` であることをコンパイラーが把握できます。型を明示的に指定せずに `(text, out result) => ...` と書けて、コンパイルも動作も正しく行われます。`int` を書いていなくても `out` 修飾子は `result` に適用されます。C# 14 がこれを推論してくれるので、ラムダの宣言が短くなり、コンパイラーがすでに知っている情報を繰り返し書かずに済みます。

同じ原理は他の修飾子にも当てはまります。参照パラメーターを取るデリゲートを考えてみましょう。

```cs
// A delegate that doubles an integer in place.
delegate void Doubler(ref int number);
```

C# 13 では、このデリゲートに合うラムダを作成するために、`ref` 修飾子と一緒に型を含める必要がありました。

```cs
// C# 13: explicit type needed for 'ref' parameter
Doubler makeDoubleOld = (ref int number) => number *= 2;
```

C# 14 では型を省略し、修飾子とパラメーター名だけを書けます。

```cs
// C# 14: implicit type with 'ref' parameter
Doubler makeDoubleNew = (ref number) => number *= 2;
```

ここでは、コンテキスト (`ref int` を受け取り void を返す `Doubler` デリゲート) から、`number` が `int` であるとコンパイラーに伝わるため、明示的に書く必要はありません。ラムダのパラメーターリストには単に `ref number` と書きます。

複数の修飾子を組み合わせたり、これらの修飾子の他の形を同じように使うこともできます。たとえば、`ref readonly` パラメーターや `scoped` パラメーターを持つデリゲートでも、C# 14 では明示的な型なしで書けます。次の例を見てください。

```cs
// A delegate with an 'in' (readonly ref) parameter
delegate void PrintReadOnly(in DateTime value);

// C# 14: using 'in' without explicit type
PrintReadOnly printDate = (in value) => Console.WriteLine(value);
```

同様に、`scoped` パラメーターを持つデリゲートの場合:

```cs
// A delegate that takes a scoped Span<int>
delegate int SumElements(scoped Span<int> data);

// C# 14: using 'scoped' without explicit type
SumElements sum = (scoped data) =>
{
    int total = 0;
    foreach (int x in data)
        total += x;
    return total;
};
```

ここでは、デリゲートから `data` が `Span<int>` (スタック専用の型) であることが分かっているので、型名を書かずに `scoped` と印を付けています。これにより、`(scoped Span<int> data)` と書いた場合と同じく、`scoped` のセマンティクスに従って `data` をラムダの外でキャプチャできないことが保証されます。

## どんな利点があるのか

修飾子付きのシンプルなラムダパラメーターを許可することで、コードはよりすっきりし、繰り返しが減ります。これまでの C# では、参照渡しや scoped パラメーターをラムダで使うために、コンパイラーが推論できる型をわざわざ書く必要がありました。これからは型の処理をコンパイラーに任せつつ、意図 (たとえば、パラメーターが参照渡しなのか出力なのか) を表現できます。これにより、デリゲートのシグネチャが複雑だったりジェネリック型を使ったりしている場合でも、簡潔で読みやすいラムダになります。

なお、この機能はラムダの実行時の挙動や修飾子そのものの動きを変えるものではなく、ラムダパラメーターを宣言する構文だけを変更します。ラムダは、明示的な型を書いた場合と同じく `ref`、`out`、`in` などのルールに従います。`scoped` 修飾子は引き続き、値がラムダの実行を超えてキャプチャされないように制約を課します。重要な改善点は、ソースコードが型名で散らかりにくくなる、ただそれだけです。

C# 14 のこの機能は、言語の他の場所にある型推論の便利さに、ラムダの構文を揃えるものです。修飾子がない場合に何年も前から型を省略できたのと同じように、`ref` などの修飾子を伴うラムダもより自然に書けるようになりました。ただし、ラムダで `params` 配列が必要な場合は、これまでどおり型を書く必要があることだけは覚えておいてください。

## 参考資料

-   [C# 14 の新機能 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
-   [修飾子付きのシンプルなラムダパラメーター | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/simple-lambda-parameters-with-modifiers)
-   [C# 14 の新機能 | StartDebugging.NET](/2024/12/csharp-14/)
