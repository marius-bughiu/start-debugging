---
title: ".NET 8 Memory<byte> é serializado como base64"
description: "A partir do .NET 8, tanto Memory<byte> quanto ReadOnlyMemory<byte> são serializados como strings Base64, enquanto outros tipos como Memory<int> continuam como arrays JSON."
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-memorybyte-is-serialized-as-base64"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, tanto `Memory<byte>` quanto `ReadOnlyMemory<byte>` são serializados como strings Base64. Veja um exemplo rápido:

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

Em contrapartida, `Memory<int>` e similares continuam sendo serializados como arrays JSON.

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
