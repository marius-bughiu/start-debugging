---
title: ".NET 8 Memory<byte> は base64 としてシリアライズされる"
description: ".NET 8 から、Memory<byte> と ReadOnlyMemory<byte> は Base64 文字列としてシリアライズされます。Memory<int> など他の型は引き続き JSON 配列のままです。"
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-memorybyte-is-serialized-as-base64"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`Memory<byte>` と `ReadOnlyMemory<byte>` はどちらも Base64 文字列としてシリアライズされるようになります。簡単な例を見てみましょう。

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

一方で、`Memory<int>` などは引き続き JSON 配列としてシリアライズされます。

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
