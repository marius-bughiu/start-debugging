---
title: "C# 12 Interceptors"
description: ".NET 8 のコンパイラーに導入された実験的機能、C# 12 の interceptors を解説します。InterceptsLocation 属性を使ってコンパイル時にメソッド呼び出しを差し替える方法を紹介します。"
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/10/c-12-interceptors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Interceptors は .NET 8 で導入された実験的なコンパイラー機能で、将来のリリースで仕様が変わったり、削除されたりする可能性があります。.NET 8 のそのほかの新機能については、[What's new in .NET 8](/2023/06/whats-new-in-net-8/) のページを見てみてください。

この機能を有効にするには、`.csproj` ファイルに `<Features>InterceptorsPreview</Features>` を追加して機能フラグを ON にする必要があります。

## interceptor とは?

interceptor とは、interceptable なメソッドの呼び出しを、自分自身の呼び出しに置き換えられるメソッドのことです。2 つのメソッドの結びつけは `InterceptsLocation` 属性を使って宣言的に行われ、置き換え自体はコンパイル時に行われ、ランタイムからはまったく見えません。

interceptors は source generator と組み合わせると、コンパイルに新しいコードを追加し、対象のメソッドを完全に置き換えるかたちで既存コードを変更するのに使えます。

## はじめに

interceptors を使い始める前に、interception を行う側のプロジェクトに `InterceptsLocationAttribute` を宣言する必要があります。機能はまだプレビュー段階で、属性自体はまだ .NET 8 に同梱されていないからです。

参考実装はこちらです。

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

それでは、動きを簡単な例で見てみましょう。`Interceptable` メソッドを持つクラス `Foo` と、そのメソッドを何度か呼び出すだけの非常にシンプルなセットアップから始めます。あとでこの呼び出しを interception の対象にします。

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

次に、実際に interception を行います。

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

ファイルパス (`C:\test\Program.cs`) は、interceptable なソースコードファイルの実際の場所に合わせて書き換えてください。書き換え終わったら、もう一度実行すると、上の `Interceptable(...)` 呼び出しの出力は次のように変わるはずです。

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

ここで一体どんな黒魔術を使ったのでしょうか? いくつか細かく見ていきましょう。

### interceptor メソッドのシグネチャ

最初に注目したいのは、interceptor メソッドのシグネチャです。これは、`this` パラメーターの型が、interceptable メソッドの所有者と同じ拡張メソッドになっています。

```cs
public static void InterceptorA(this Foo foo, int param)
```

これはプレビュー時点での制限で、機能がプレビューを抜ける前に取り除かれる予定です。

### `filePath` パラメーター

interception 対象となるソースコードファイルへのパスを表します。

source generator の中でこの属性を適用する場合は、コンパイラーが行うのと同じパス変換を適用して、ファイルパスを正規化してください。

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### `line` と `column`

これらは 1 始まりの位置で、interceptable メソッドが呼び出されている正確な場所を指します。

`column` の場合、呼び出し位置は interceptable メソッド名の最初の文字の位置です。たとえば次のとおりです。

-   `foo.Interceptable(...)` の場合は、`I` の位置です。コードの前にスペースがなければ `5` になります。
-   `System.Console.WriteLine(...)` の場合は、`W` の位置です。コードの前にスペースがなければ `column` は `16` になります。

### 制限事項

interceptors は普通のメソッドにのみ機能します。今のところ、コンストラクター、プロパティ、ローカル関数を interception することはできませんが、対応するメンバーの一覧は将来変わる可能性があります。
