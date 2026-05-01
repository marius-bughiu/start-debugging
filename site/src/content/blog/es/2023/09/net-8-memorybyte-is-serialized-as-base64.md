---
title: ".NET 8 Memory<byte> se serializa como base64"
description: "A partir de .NET 8, tanto Memory<byte> como ReadOnlyMemory<byte> se serializan como cadenas Base64, mientras que otros tipos como Memory<int> siguen como arrays JSON."
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/net-8-memorybyte-is-serialized-as-base64"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8, tanto `Memory<byte>` como `ReadOnlyMemory<byte>` se serializan como cadenas Base64. Veamos un ejemplo rápido:

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

En cambio, `Memory<int>` y similares seguirán serializándose como arrays JSON.

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
