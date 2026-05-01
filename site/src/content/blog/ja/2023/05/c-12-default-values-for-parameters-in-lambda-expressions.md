---
title: "C# 12 - ラムダ式のパラメーターに既定値を指定"
description: "C# 12 では、メソッドやローカル関数と同じように、ラムダ式のパラメーターに既定値や params 配列を指定できます。"
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/05/c-12-default-values-for-parameters-in-lambda-expressions"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# のバージョン 12 から、ラムダ式のパラメーターに既定値を指定できるようになりました。既定値の構文と制約は、メソッドやローカル関数と同じです。

例を見てみましょう。

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

このラムダは、次のように使用できます。

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## ラムダ式の params 配列

ラムダ式は、**params** 配列をパラメーターとして宣言することもできます。

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

そして他の関数と同じように利用できます。

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## エラー CS8652

> The feature 'lambda optional parameters' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

ラムダのオプションパラメーター機能を使うには、プロジェクトが .NET 8 および C# 12 以降をターゲットにする必要があります。C# 12 への切り替え方法がわからない場合は、こちらの記事をご覧ください: [C# 12 への切り替え方法](/ja/2023/06/how-to-switch-to-c-12/)。
