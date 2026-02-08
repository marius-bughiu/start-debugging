---
title: "NET 8 – Serialization of Half, Int128, and UInt128"
description: "System.Text.Json brings out of the box support for additional types: Let’s look at an example:"
pubDate: 2023-09-07
updatedDate: 2023-11-12
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
`System.Text.Json` brings out of the box support for additional types:

-   [Half](https://learn.microsoft.com/en-us/dotnet/api/system.half?view=net-8.0)
-   [Int128](https://learn.microsoft.com/en-us/dotnet/api/system.int128?view=net-8.0)
-   [UInt128](https://learn.microsoft.com/en-us/dotnet/api/system.uint128?view=net-8.0)

Let’s look at an example:

```cs
Console.WriteLine(JsonSerializer.Serialize(Half.MaxValue));
// Output: 65500

Console.WriteLine(JsonSerializer.Serialize(Int128.MaxValue));
// Output: 170141183460469231731687303715884105727

Console.WriteLine(JsonSerializer.Serialize(UInt128.MaxValue));
// Output: 340282366920938463463374607431768211455
```
