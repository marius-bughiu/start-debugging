---
title: ".NET 8 Memory<byte> сериализуется как base64"
description: "Начиная с .NET 8, и Memory<byte>, и ReadOnlyMemory<byte> сериализуются как строки Base64, тогда как другие типы вроде Memory<int> остаются JSON-массивами."
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-memorybyte-is-serialized-as-base64"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8 и `Memory<byte>`, и `ReadOnlyMemory<byte>` сериализуются как строки Base64. Рассмотрим небольшой пример:

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

При этом `Memory<int>` и подобные типы продолжают сериализоваться как JSON-массивы.

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
