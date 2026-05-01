---
title: ".NET 8 Memory<byte> wird als Base64 serialisiert"
description: "Ab .NET 8 werden sowohl Memory<byte> als auch ReadOnlyMemory<byte> als Base64-Strings serialisiert, während andere Typen wie Memory<int> weiter als JSON-Arrays bleiben."
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-memorybyte-is-serialized-as-base64"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 werden sowohl `Memory<byte>` als auch `ReadOnlyMemory<byte>` als Base64-Strings serialisiert. Sehen wir uns ein kurzes Beispiel an:

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

`Memory<int>` und ähnliche Typen werden dagegen weiterhin als JSON-Arrays serialisiert.

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
