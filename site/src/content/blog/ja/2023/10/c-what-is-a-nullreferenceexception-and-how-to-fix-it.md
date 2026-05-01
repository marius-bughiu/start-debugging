---
title: "C# NullReferenceException とは何で、どう直すか?"
description: "C# で NullReferenceException が発生する原因、デバッグの仕方、null チェックや null 条件演算子、null 許容参照型を使った防止方法を解説します。"
pubDate: 2023-10-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/10/c-what-is-a-nullreferenceexception-and-how-to-fix-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
`NullReferenceException` は、コードがオブジェクトやそのメンバーにアクセスしたり、それを操作しようとしたりしたものの、対象のオブジェクト参照が現在 `null` になっている (つまり、メモリ上のどの有効なオブジェクトも参照していない) ときに発生する、よくある実行時エラーです。言い換えれば、存在しないものに対して何かをしようとしている、ということです。

ごく簡単な例です。

```cs
string myString = null;
int length = myString.Length;
```

この例では、`myString` という string 変数に `null` が代入されています。その `Length` プロパティにアクセスしようとすると、存在しない文字列の長さは取れないため、`NullReferenceException` がスローされます。

## どうやってデバッグする?

まず注力すべきは、null 参照の出どころを特定することです。デバッガーを使えば、問題の場所を正確に絞り込めます。

最初に、デバッガーが示す例外の詳細をしっかり確認しましょう。例外が発生した正確なコード行が表示されます。この行は、null 参照の原因になっている変数やオブジェクトを特定するうえで非常に重要です。

次に、エディターの `Locals` ウィンドウや `Watch` ウィンドウを使ったり、変数の上にマウスを重ねたりして、変数やオブジェクトを調べます。これらのツールを使うと、例外が発生した時点でのアプリケーションの状態を確認できます。例外を引き起こした行で使われている変数には特に注意を払いましょう。それらのうちのどれかが、本来 null であってはいけないのに null になっていれば、それが問題の原因である可能性が高いです。

さらに、Call Stack ウィンドウで呼び出し履歴をたどり、例外までに至ったメソッド呼び出しを確認しましょう。これにより、null 参照が発生したコンテキストを把握しやすくなり、根本原因の特定にも役立ちます。原因となっている変数やオブジェクトを特定したら、その後は null チェックを行い、適切な null 検査を入れて将来的な例外を防ぐことで問題を修正できます。

## どう防ぐ?

`NullReferenceException` を防ぐには、オブジェクトのプロパティやメソッドにアクセスする前に `null` をチェックすることが非常に重要です。`if` のような条件文を使って、メンバーにアクセスする前に `null` を確認できます。たとえばこうです。

```cs
string myString = null; 

if (myString != null) 
{ 
    int length = myString.Length; // This will only execute if 'myString' is not null. 
}
```

または、C# 6.0 で導入された null 条件演算子を使って、null になりうるオブジェクトのメンバーに安全にアクセスする方法もあります。

```cs
string myString = null; 
int? length = myString?.Length; // 'length' will be null if 'myString' is null.
```

### null 許容参照型

`NullReferenceException` を避けるもうひとつの方法は、C# 8.0 で導入された null 許容参照型を有効にすることです。これは、クラスやインターフェースなどの参照型が null 許容なのか、そうでないのかを表現する手段を提供することで、より安全で信頼性の高いコードを書けるようにする機能です。コンパイル時に潜在的な null 参照例外を検出でき、コードの可読性や保守性も向上します。

null 許容参照型を有効にすると、コンパイラーは潜在的な null 参照の問題に対して警告を出します。意図を明確にするための注釈を加えることで、警告を減らしたりなくしたりできます。

null 許容参照型では、参照型が `null` を許容するかどうかを注釈で示します。

-   `T?`: 参照型 `T` が `null` でありうることを示します。
-   `T`: 参照型 `T` が null 非許容であることを示します。
