---
title: ".NET 11 Adds Native Zstandard Compression to System.IO.Compression"
description: ".NET 11 Preview 1 ships ZstandardStream, ZstandardEncoder, and ZstandardDecoder in System.IO.Compression, giving you fast, inbox zstd support with no third-party packages."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
---

.NET developers who needed Zstandard compression have relied on third-party wrappers like ZstdSharp or ZstdNet for years. Starting with [.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/), that changes: `System.IO.Compression` now ships `ZstandardStream`, `ZstandardEncoder`, and `ZstandardDecoder` as first-class APIs, no NuGet detour required.

## Why Zstandard Matters

Zstandard (zstd), developed by Meta, sits in a sweet spot between speed and ratio. Internal benchmarks from the .NET team show it compresses 2-7x faster than Brotli and Deflate at equivalent quality, and decompresses 2-14x faster at the fastest level. For HTTP payloads, log shipping, or binary serialization, that gap is significant.

## Streaming Compression in Five Lines

The API mirrors `BrotliStream` and `GZipStream`, so the migration path is familiar:

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

Decompression is the mirror image: wrap the input stream and read.

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## Fine-Grained Control with ZstandardEncoder

When you need to set compression levels or use trained dictionaries, drop down to `ZstandardEncoder`:

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

Compression levels range from 1 (fastest) to 22 (smallest output). Level 3, the default, already beats Deflate ratios for most workloads. `ZstandardDictionary` lets you train on representative samples for even better ratios on small, repetitive payloads like API responses or log lines.

## HttpClient Gets Automatic Zstd Decompression

`DecompressionMethods` now includes a `Zstandard` member, so opting in to transparent HTTP decompression is one flag:

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

If the server sends a `Content-Encoding: zstd` response, the handler decompresses it before your code ever sees the stream.

## What to Try Now

Install the [.NET 11 Preview SDK](https://dotnet.microsoft.com/download/dotnet/11.0), target `net11.0`, and swap one of your existing `BrotliStream` or `GZipStream` call sites to `ZstandardStream`. Measure throughput and compressed size: the numbers tend to speak for themselves.

The full API surface, including `ZstandardCompressionOptions` for window size tuning, is documented on [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0).
