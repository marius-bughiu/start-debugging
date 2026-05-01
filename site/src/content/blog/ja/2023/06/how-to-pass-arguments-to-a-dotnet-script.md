---
title: "dotnet script に引数を渡す方法"
description: "区切り記号 -- を使って dotnet script に引数を渡し、Args コレクション経由でアクセスする方法を学びます。"
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
lang: "ja"
translationOf: "2023/06/how-to-pass-arguments-to-a-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
**dotnet script** を使うとき、**--** (ハイフン 2 個) の後に指定することで引数を渡せます。スクリプト内では **Args** コレクションを通じてその引数にアクセスできます。

例を見てみましょう。次のような **myScript.csx** スクリプトファイルがあるとします。

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

このスクリプトには、次のようにパラメーターを渡せます。

```shell
dotnet script myScript.csx -- "a" "b"
```
