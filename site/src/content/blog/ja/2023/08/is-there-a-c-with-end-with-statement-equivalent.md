---
title: "C# に With...End With 文に相当する構文はありますか？"
description: "VB の With...End With 文は、単一のオブジェクトを繰り返し参照する一連の文を、メンバーアクセスのための簡略化された構文で実行できます。C# に相当する構文はあるでしょうか。ありません。最も近いのはオブジェクト初期化子ですが、これは新しいオブジェクトのインスタンス化にしか使えません。"
pubDate: 2023-08-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/08/is-there-a-c-with-end-with-statement-equivalent"
translatedBy: "claude"
translationDate: 2026-05-01
---
VB の With...End With 文を使うと、単一のオブジェクトを繰り返し参照する一連の文を実行できます。これにより、オブジェクトのメンバーへアクセスするための簡略化された構文を利用できます。例えば、次のようになります。

```vb
With car
    .Make = "Mazda"
    .Model = "MX5"
    .Year = 1989
End With
```

## C# に相当する構文はありますか

ありません。存在しません。最も近いのはオブジェクト初期化子ですが、これは新しいオブジェクトをインスタンス化するときにのみ使用でき、with 文のように既存のオブジェクトインスタンスを更新するためには使えません。

例えば、新しいオブジェクトインスタンスを作成するときには、オブジェクト初期化子を使えます。

```cs
var car = new Car
{
    Make = "Mazda",
    Model = "MX5",
    Year = 1989
};
```

しかし、オブジェクトを更新する場合には、これに相当する簡略化された構文はありません。次のように、各代入やメンバー呼び出しのたびにオブジェクトを参照する必要があります。

```cs
car.Make = "Aston Martin";
car.Model = "DBS";
car.Year = 1967;
```
