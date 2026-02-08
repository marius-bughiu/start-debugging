---
title: ".NET 8 – Memory<byte> is serialized as base64"
description: "Starting with .NET 8, both Memory<byte> and ReadOnlyMemory<byte> are serialized as Base64 strings, while other types like Memory<int> remain JSON arrays."
pubDate: 2023-09-06
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
Starting with .NET 8, both `Memory<byte>` and `ReadOnlyMemory<byte>` are serialized as Base64 strings. Let's look at a quick example:

```cs
var bar = new byte[] { 28, 70, 0 };

JsonSerializer.Serialize<Memory<byte>>(bar);
JsonSerializer.Serialize<ReadOnlyMemory<byte>>(bar);
// Output: "HEYA"
```

In contrast, `Memory<int>` and the likes will continue to be serialized as JSON arrays.

```cs
JsonSerializer.Serialize<Memory<int>>(new int[] { 28, 70, 0 });
// Output: [28,70,0]
```
