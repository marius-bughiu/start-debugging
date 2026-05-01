---
title: "C# リストからランダムに項目を選ぶ"
description: ".NET 8 で導入された Random.GetItems を使うと、C# でリストからランダムに項目を選択できます。実用的な例とともに動作を解説します。"
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/c-randomly-choose-items-from-a-list"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# では、.NET 8 で導入された `Random.GetItems` を使ってリストからランダムに項目を選択できます。

```cs
public T[] GetItems<T>(T[] choices, int length)
```

このメソッドは 2 つのパラメーターを受け取ります。

-   `choices` -- 選択候補となる項目のリスト / 可能性のリスト。
-   `length` -- 選び取る項目の数。

このメソッドについて、重要な点が 2 つあります。

-   結果のリストには重複が含まれる可能性があり、ユニークな選択のリストではありません。
-   このため、`length` パラメーターは候補リストの長さより大きくすることができます。

これを踏まえて、いくつか例を見てみましょう。次の選択肢の配列を仮定します。

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

そのリストから 2 つのフルーツをランダムに選択するには、単に次のように呼び出します。

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

先ほど述べたように、選ばれる 2 つのフルーツは必ずしもユニークではありません。たとえば、`chosen` 配列に `[ "kiwi", "kiwi" ]` が入る可能性もあります。これは do-while で簡単に検証できます。

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

そしてこのメソッドでは、実際にリストにある数より多くの項目を選択することもできます。今回の例ではフルーツは 4 つしかありませんが、`GetItems` に 10 個のフルーツを選ぶよう頼んでも、問題なくそうしてくれます。

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
