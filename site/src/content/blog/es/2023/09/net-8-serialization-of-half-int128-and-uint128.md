---
title: ".NET 8 serialización de Half, Int128 y UInt128"
description: "System.Text.Json en .NET 8 añade soporte integrado de serialización para los tipos numéricos Half, Int128 y UInt128."
pubDate: 2023-09-07
updatedDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-serialization-of-half-int128-and-uint128"
translatedBy: "claude"
translationDate: 2026-05-01
---
`System.Text.Json` trae soporte de fábrica para tipos adicionales:

-   [Half](https://learn.microsoft.com/en-us/dotnet/api/system.half?view=net-8.0)
-   [Int128](https://learn.microsoft.com/en-us/dotnet/api/system.int128?view=net-8.0)
-   [UInt128](https://learn.microsoft.com/en-us/dotnet/api/system.uint128?view=net-8.0)

Veamos un ejemplo:

```cs
Console.WriteLine(JsonSerializer.Serialize(Half.MaxValue));
// Output: 65500

Console.WriteLine(JsonSerializer.Serialize(Int128.MaxValue));
// Output: 170141183460469231731687303715884105727

Console.WriteLine(JsonSerializer.Serialize(UInt128.MaxValue));
// Output: 340282366920938463463374607431768211455
```
