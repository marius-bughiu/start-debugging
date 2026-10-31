---
title: "grpc-dotnet 2.85 Enforces MaxReceiveMessageSize After Decompression, Not Just Before"
description: "Grpc.AspNetCore and Grpc.Net.Client 2.85.0 now apply MaxReceiveMessageSize to the decompressed size of gzip and deflate messages. A 260 KB request that inflates to 256 MiB is rejected with ResourceExhausted, but legitimate large compressed payloads can start failing too."
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
---

[grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) shipped on October 29, 2026, and `Grpc.AspNetCore.Server` and `Grpc.Net.Client` 2.85.0 are already on NuGet. The release notes are four lines long, and one of them is easy to skim past: "Enforce receive message size limits during decompression". It closes a real memory-exhaustion hole, and it can also start rejecting traffic that worked yesterday.

## What the limit used to measure

Both `GrpcServiceOptions.MaxReceiveMessageSize` on the server and `GrpcChannelOptions.MaxReceiveMessageSize` on the client default to 4 MB (4,194,304 bytes). Until 2.84.0, that check ran against the length prefix of the gRPC frame, which for a compressed message is the **compressed** size. After the check passed, the message was inflated with a plain `compressionStream.CopyTo(new MemoryStream())`, with no cap at all.

So a peer that sent `grpc-encoding: gzip` could pass the 4 MB check with a tiny payload and make the other side allocate whatever the data inflated to. The reproduction in [PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) is a 260,934-byte compressed request that expands to 256 MiB. You did not have to opt in: when `CompressionProviders` is empty, `GrpcServiceOptionsSetup` registers `GzipCompressionProvider` and `DeflateCompressionProvider` for you, and `GrpcChannel` ships with the same defaults. Every ASP.NET Core gRPC service was exposed to its callers, and every client was exposed to the servers it called.

## How 2.85.0 reads compressed messages

The fix moves decompression on both sides into a shared `CommonGrpcProtocolHelpers.TryReadCompressedMessage`. When a limit is configured, it reads the decompression stream in 8 KB pooled chunks and never requests more than one byte past the limit:

```csharp
// Read at most one byte beyond the limit to detect oversized messages without fully decompressing them.
while ((read = compressionStream.Read(buffer, 0, (int)Math.Min(buffer.Length, maxReceiveMessageSize.Value - output.Length + 1))) > 0)
{
    if (output.Length + read > maxReceiveMessageSize.Value)
    {
        message = default;
        return false;
    }

    output.Write(buffer, 0, read);
}
```

The call then fails with `StatusCode.ResourceExhausted` and the detail "Received message exceeds the maximum configured message size." before your service method or the client's deserializer sees anything. In the PR's reproduction, the 256 MiB bomb now costs about 9 MiB of allocations. The compressed-frame check still runs first, a message exactly at the limit is still accepted, and a `null` limit keeps the old unbounded behavior.

## The upgrade gotcha: legitimate payloads count too

The limit now means "the message your code receives", which is what most people assumed it meant. But if you already move compressed messages that inflate past 4 MB (bulk exports, batch uploads, snapshot streams of highly repetitive data), those calls worked on 2.84.0 because only the compressed size was checked. On 2.85.0 they get `ResourceExhausted`.

Raise the limit deliberately, and as narrowly as possible:

```csharp
builder.Services.AddGrpc(options =>
{
    options.ResponseCompressionAlgorithm = "gzip";
    // Global default stays at 4 MB
})
.AddServiceOptions<ExportService>(options =>
{
    // This service legitimately receives large batches
    options.MaxReceiveMessageSize = 32 * 1024 * 1024;
});

// Client side, for responses that inflate past 4 MB
using var channel = GrpcChannel.ForAddress("https://exports.internal", new GrpcChannelOptions
{
    MaxReceiveMessageSize = 32 * 1024 * 1024
});
```

Avoid setting `MaxReceiveMessageSize = null` to make the errors go away: that restores exactly the unbounded inflation this release removes.

Before upgrading, find out which of your callers actually compress: look for a `grpc-encoding` request header other than `identity` in your traces, or for `grpc-internal-encoding-request` metadata and `ResponseCompressionAlgorithm` in your client and server setup. If nothing compresses, 2.85.0 is a drop-in update. If something does, measure the decompressed size of your largest real message and set the per-service limit above it. For the broader picture of where gRPC fits next to REST and SignalR, see [gRPC vs REST vs SignalR for service-to-service calls in .NET 11](/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/).
