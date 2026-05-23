---
title: ".NET 11 Adds Allocation-Free Deflate and GZip Compression"
description: ".NET 11 Preview 4 ships DeflateEncoder, GZipEncoder, and ZLibEncoder plus matching decoders so you can compress straight into a Span<byte> with OperationStatus, no Stream required."
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
---

The [.NET 11 Preview 4 library notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) quietly close a gap that has bugged anyone who compresses small payloads in a hot path. `System.IO.Compression` now ships `DeflateEncoder`, `GZipEncoder`, and `ZLibEncoder`, along with `DeflateDecoder`, `GZipDecoder`, and `ZLibDecoder`. They compress and decompress directly between spans, with no `Stream` in sight. This is separate from the [Zstandard support added in Preview 1](/2026/04/dotnet-11-zstandard-compression-system-io/): these are the classic algorithms finally getting the buffer-based shape that `BrotliEncoder` has had since .NET Core 2.1.

## Why GZipStream Allocates More Than You Think

Gzipping a `byte[]` that already lives in memory used to mean routing it through a stream:

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

That allocates a `MemoryStream`, an internal copy buffer, and a fresh `byte[]` from `ToArray()`, none of which you can pool. On a request path that compresses thousands of small blobs, that pressure shows up in GC traces.

## One-Shot Into a Pooled Buffer

The new encoders expose a static one-shot that writes into a destination you own:

```csharp
using System.Buffers;
using System.IO.Compression;

ReadOnlySpan<byte> source = payload;
byte[] buffer = ArrayPool<byte>.Shared.Rent(
    GZipEncoder.GetMaxCompressedLength(source.Length));

if (GZipEncoder.TryCompress(source, buffer, out int written))
{
    Use(buffer.AsSpan(0, written));
}

ArrayPool<byte>.Shared.Return(buffer);
```

No stream, no intermediate copy, and the scratch buffer goes back to the pool. `GetMaxCompressedLength` sizes the rental so `TryCompress` never fails for lack of space.

## Streaming Buffers Without a Stream

For data that arrives in chunks, the instance API drives an `OperationStatus` loop. You feed spans in, drain spans out, and flag the last call:

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

The return value tells you what to do next: `Done`, `DestinationTooSmall` (grow the output and call again), or `NeedMoreData` (hand it the next input span). Decompression mirrors it with `GZipDecoder.Decompress`, which also reports `bytesConsumed` and `bytesWritten` so you can resume across partial frames. This is the same contract `BrotliEncoder` and the Preview 1 `ZstandardEncoder` use, so multi-algorithm code can share one loop.

## When To Reach For It

Streams are still the right tool when you are piping a file to disk or a response body where the framework owns the buffering. The new encoders win when the data is already in memory and you care about allocations: caching compressed fragments, packing records into a binary format, or compressing many tiny messages. Target `net11.0` against the [Preview 4 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) and swap one `GZipStream` over a `MemoryStream` for `GZipEncoder.TryCompress`. The allocation delta is hard to miss.
