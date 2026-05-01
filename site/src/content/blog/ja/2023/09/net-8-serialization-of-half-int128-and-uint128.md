---
title: ".NET 8 Half、Int128、UInt128 のシリアライズ"
description: ".NET 8 の System.Text.Json は、Half、Int128、UInt128 という数値型のシリアライズに、組み込みで対応するようになりました。"
pubDate: 2023-09-07
updatedDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-serialization-of-half-int128-and-uint128"
translatedBy: "claude"
translationDate: 2026-05-01
---
`System.Text.Json` は、追加の型に対する組み込みのサポートを提供します。

-   [Half](https://learn.microsoft.com/en-us/dotnet/api/system.half?view=net-8.0)
-   [Int128](https://learn.microsoft.com/en-us/dotnet/api/system.int128?view=net-8.0)
-   [UInt128](https://learn.microsoft.com/en-us/dotnet/api/system.uint128?view=net-8.0)

例を見てみましょう。

```cs
Console.WriteLine(JsonSerializer.Serialize(Half.MaxValue));
// Output: 65500

Console.WriteLine(JsonSerializer.Serialize(Int128.MaxValue));
// Output: 170141183460469231731687303715884105727

Console.WriteLine(JsonSerializer.Serialize(UInt128.MaxValue));
// Output: 340282366920938463463374607431768211455
```
