---
title: "C# using var (using 宣言)"
description: "C# 8 の using 宣言 (`using var`) を使えば、入れ子の波かっこなしで IDisposable オブジェクトを破棄できます。構文、スコープのルール、`using` ブロックを選ぶべき場面を解説します。"
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2020/05/c-using-var-using-declaration"
translatedBy: "claude"
translationDate: 2026-05-01
---
囲んでいるスコープが終了したときに自動的に破棄されるものを宣言できたら、しかも、コードに余計な波かっことインデントを増やさずに……と思ったことはありませんか？それはあなただけではありません。C# 8 の using 宣言にようこそ 🥰。

using var を使うと、次のように書けるようになります。

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

これまでの形は次のようなものでした。

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

不要な波かっこも、追加のインデントもありません。disposable のスコープは、その親スコープと一致します。

ここで、もう少し完全な using var の例を見てみましょう。

```cs
static int SplitFile(string filePath)
{
    var dir = Path.GetDirectoryName(filePath);
    using var sourceFile = new StreamReader(filePath);

    int count = 0;
    while(!sourceFile.EndOfStream)
    {
        count++;

        var line = sourceFile.ReadLine();

        var linePath = Path.Combine(dir, $"{count}.txt");
        using var lineFile = new StreamWriter(linePath);

        lineFile.WriteLine(line);

    } // lineFile is disposed here, at the end of each individual while loop

    return count;

} // sourceFile is disposed here, at the end of its enclosing scope
```

上の例から分かるように、囲んでいるスコープはメソッドである必要はありません。例えば `for`、`foreach`、`while` の内側でもよいですし、思い切って `using` ブロックの内側でも構いません。いずれの場合も、オブジェクトはその囲みスコープの終わりで破棄されます。

## エラー CS1674

using var 宣言は、`using` の後の式が `IDisposable` ではない場合にコンパイル時エラーも提供します。

> Error CS1674 'string': type used in a using statement must be implicitly convertible to 'System.IDisposable'.

## ベストプラクティス

`using var` のベストプラクティスについては、概ね using ステートメントを扱う場合と同じガイドラインに従えば問題ありません。それに加えて、次のようにすると良いでしょう。

-   disposable 変数はスコープの先頭で、他の変数と分けて宣言する。そうすれば目立ち、コードを追うときに見つけやすくなる
-   どのスコープで作成するかに注意する。そのスコープ全体の間、対象が生き続けるからです。disposable な値が短命な子スコープ内でしか必要ないなら、そこで作成するのが理にかなっていることがあります。
