---
title: "How to upload a large file with streaming to Azure Blob Storage"
description: "Upload multi-GB files to Azure Blob Storage from .NET 11 without loading them into memory. BlockBlobClient.UploadAsync with StorageTransferOptions, MultipartReader for ASP.NET Core uploads, and the buffering traps that put your payload on the LOH."
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
---

Open the source as a `Stream` and pass it straight to `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` with `StorageTransferOptions` set. The Azure SDK chunks the stream into block-blob blocks, stages them in parallel, and commits the block list when the stream ends. You never allocate a `byte[]` larger than `MaximumTransferSize`, and the source stream is read once, forward-only. The patterns that quietly break this are: copying the request body into a `MemoryStream` "to know the length", calling `IFormFile.OpenReadStream` after ASP.NET Core has already buffered the form into memory, and forgetting to set `MaximumConcurrency` -- which leaves you uploading 4 MiB at a time on a single thread to a service that happily accepts twenty parallel block stagings.

This post targets `Azure.Storage.Blobs` 12.22+, .NET 11, and ASP.NET Core 11. The block-blob protocol limits used here (4000 MiB per block, 50,000 blocks, ~190.7 TiB total per blob) require x-ms-version `2019-12-12` or later, which the SDK negotiates by default.

## The default upload path is already streaming, sort of

`BlobClient.UploadAsync(Stream)` does the right thing for a stream of unknown length: it reads up to `InitialTransferSize` bytes, and if the stream ended within that window it issues a single `PUT Blob` request. Otherwise it switches to staged block uploads, reading `MaximumTransferSize` bytes at a time and calling `PUT Block` in parallel up to `MaximumConcurrency`. Once the source stream returns 0 bytes, it issues `PUT Block List` to commit the order.

The defaults that ship in 12.22 are `InitialTransferSize = 256 MiB`, `MaximumTransferSize = 8 MiB`, `MaximumConcurrency = 8`. Two things are wrong with leaving those alone for large uploads. First, `InitialTransferSize = 256 MiB` means the SDK will buffer up to 256 MiB internally before deciding whether to use a single PUT, even if you passed it a 50 GiB stream that obviously cannot fit. Second, `MaximumConcurrency = 8` is fine for a 1 Gbps link to a colocated storage account but is a bottleneck for cross-region uploads where each PUT round-trip costs 80-200 ms.

```csharp
// .NET 11, Azure.Storage.Blobs 12.22
var transferOptions = new StorageTransferOptions
{
    InitialTransferSize = 8 * 1024 * 1024,   // 8 MiB. Always go via block uploads for large files.
    MaximumTransferSize = 8 * 1024 * 1024,   // 8 MiB blocks. Sweet spot for most networks.
    MaximumConcurrency  = 16                  // Parallel PUT Block calls.
};

var uploadOptions = new BlobUploadOptions
{
    TransferOptions = transferOptions,
    HttpHeaders     = new BlobHttpHeaders { ContentType = "application/octet-stream" }
};

await using FileStream source = File.OpenRead(localPath);
await blobClient.UploadAsync(source, uploadOptions, cancellationToken);
```

Block sizes between 4 MiB and 16 MiB are the sweet spot for Standard storage accounts. Smaller blocks waste round-trips on the `PUT Block` overhead; larger blocks make retries expensive because a transient 503 forces the SDK to re-send the entire block.

## The block-blob limits that decide block size for you

Azure block blobs have hard limits that a "just stream it" mindset will hit eventually. There are 50,000 blocks per blob, each block is at most 4000 MiB, and the maximum blob size is 190.7 TiB (50,000 x 4000 MiB). For a 200 GiB upload, 4 MiB blocks need 51,200 blocks -- one over the limit. So:

- Up to ~195 GiB: any block size from 4 MiB upward works.
- 195 GiB to ~390 GiB: minimum 8 MiB.
- 1 TiB: minimum 21 MiB. The SDK's default 8 MiB will fail mid-upload with `BlockCountExceedsLimit`.

The SDK does not raise the block size for you. If you know the source length up front, compute the required block size and set `MaximumTransferSize` accordingly:

```csharp
// .NET 11
static long PickBlockSize(long contentLength)
{
    const long maxBlocks = 50_000;
    const long minBlock  = 4 * 1024 * 1024;          // 4 MiB
    const long maxBlock  = 4000L * 1024 * 1024;      // 4000 MiB

    long required = (contentLength + maxBlocks - 1) / maxBlocks;
    long rounded  = ((required + minBlock - 1) / minBlock) * minBlock;
    return Math.Clamp(rounded, minBlock, maxBlock);
}
```

For uploads of unknown length (a generated archive, a server-side fan-in), default to 16 MiB blocks. That gives headroom up to ~780 GiB without raising the limit later.

## ASP.NET Core: stream the request body, not `IFormFile`

The most common way this whole pipeline gets ruined is `IFormFile`. When a multipart upload arrives, ASP.NET Core's `FormReader` reads the entire body into the form collection before your action runs. Anything below `FormOptions.MemoryBufferThreshold` (default 64 KiB per form value, but the file part follows `MultipartBodyLengthLimit` of 128 MiB) goes to memory; anything above goes to a `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream`, which is a temp file on disk. Either way, by the time your handler runs, the upload has been read once and copied somewhere. `IFormFile.OpenReadStream()` is now a `FileStream` over that temp copy.

This kills three things at once. You pay disk I/O for a buffer you do not need. The request takes twice as long because the bytes travel from socket to temp file, then from temp file to the SDK to Azure. And `MultipartBodyLengthLimit` puts a 128 MiB ceiling on every upload by default.

The fix is to disable form binding and read the multipart stream yourself with `MultipartReader`:

```csharp
// .NET 11, ASP.NET Core 11
[HttpPost("upload")]
[DisableFormValueModelBinding]
[RequestSizeLimit(50L * 1024 * 1024 * 1024)]      // 50 GiB
[RequestFormLimits(MultipartBodyLengthLimit = 50L * 1024 * 1024 * 1024)]
public async Task<IActionResult> Upload(CancellationToken ct)
{
    if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType) ||
        !mediaType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
    {
        return BadRequest("Expected multipart/form-data.");
    }

    string boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value!;
    var reader = new MultipartReader(boundary, Request.Body);

    MultipartSection? section;
    while ((section = await reader.ReadNextSectionAsync(ct)) != null)
    {
        var contentDisposition = section.GetContentDispositionHeader();
        if (contentDisposition is null || !contentDisposition.IsFileDisposition()) continue;

        string fileName = Path.GetFileName(contentDisposition.FileName.Value!);
        var blob = _container.GetBlockBlobClient(fileName);

        var options = new BlobUploadOptions
        {
            TransferOptions = new StorageTransferOptions
            {
                InitialTransferSize = 8 * 1024 * 1024,
                MaximumTransferSize = 16 * 1024 * 1024,
                MaximumConcurrency  = 16
            },
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = section.ContentType ?? "application/octet-stream"
            }
        };

        await blob.UploadAsync(section.Body, options, ct);
    }

    return Ok();
}
```

`section.Body` is a network-backed stream that reads directly from the request body. The Azure SDK reads from it, slices into blocks, and uploads. Memory stays bounded by `MaximumTransferSize * MaximumConcurrency` (256 MiB in the example above). The `[DisableFormValueModelBinding]` attribute is a tiny custom filter that strips the framework's default form-value providers so MVC does not try to bind the body before your action runs:

```csharp
// .NET 11, ASP.NET Core 11
public class DisableFormValueModelBindingAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var factories = context.ValueProviderFactories;
        factories.RemoveType<FormValueProviderFactory>();
        factories.RemoveType<FormFileValueProviderFactory>();
        factories.RemoveType<JQueryFormValueProviderFactory>();
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
```

`[RequestSizeLimit]` and `[RequestFormLimits]` are both required: the first is Kestrel's per-request body cap, the second is `FormOptions.MultipartBodyLengthLimit`. Forgetting either one rejects the upload at 30 MiB or 128 MiB respectively, with an error that does not mention multipart.

## Authenticating without a SAS

`DefaultAzureCredential` from `Azure.Identity` is the right default for any service running in Azure (App Service, AKS, Functions, Container Apps). The container needs the `Storage Blob Data Contributor` role on the storage account. Locally the same code works against `az login` or VS Code's Azure account.

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

Avoid storing connection strings with the account key in app settings. The key authenticates at the storage-account level, which means a leaked key gives full access to every container and every blob, including delete. The same upload paths work with `BlobSasBuilder` if a browser uploads directly without going through your server.

## Progress, retries, and resumability

The SDK calls `IProgress<long>` after each block. Use it for UI but not for accounting -- the value is the cumulative bytes transferred including bytes that were retried.

```csharp
// .NET 11
var progress = new Progress<long>(bytes =>
{
    Console.WriteLine($"{bytes:N0} bytes transferred");
});

var options = new BlobUploadOptions
{
    TransferOptions  = transferOptions,
    ProgressHandler  = progress
};
```

The transport layer retries `PUT Block` automatically with exponential backoff (`RetryOptions` defaults to 3 retries, 0.8s initial delay). For a multi-hour upload on a flaky network, raise `RetryOptions.MaxRetries` and `NetworkTimeout` on `BlobClientOptions` before constructing the client:

```csharp
// .NET 11
var clientOptions = new BlobClientOptions
{
    Retry =
    {
        MaxRetries     = 10,
        Delay          = TimeSpan.FromSeconds(2),
        MaxDelay       = TimeSpan.FromSeconds(60),
        Mode           = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromMinutes(10)
    }
};

var service = new BlobServiceClient(serviceUri, new DefaultAzureCredential(), clientOptions);
```

`UploadAsync` is not resumable across process restarts. If the process dies, the staged-but-not-committed blocks linger on the storage account for up to seven days, then garbage-collect. To resume manually, use `BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)` to discover what was staged, stream the source from that offset, and call `CommitBlockListAsync` with the merged list. Most apps don't need this; restarting the upload from byte 0 is simpler and the SDK's parallelism makes it cheap.

## CancellationToken: pass it everywhere

The `CancellationToken` you hand to `UploadAsync` is honored on every staged block, but only between blocks. A single `PUT Block` does not abort mid-flight; the SDK waits for it to finish (or fail) before observing the token. For a 16 MiB block on a 1 Gbps link that is ~130 ms, which is fine. On a 10 Mbps link it is 13 seconds. If a fast cancel matters, drop `MaximumTransferSize` to 4 MiB so the worst-case in-flight block is small.

The same warning applies if you set `NetworkTimeout` very high. `CancellationToken` does not preempt a hung socket -- the timeout does. Keep `NetworkTimeout` smaller than your acceptable cancellation latency. The pattern for cooperative cancellation is the same one covered in detail in [cancelling a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): pass the token down, let `OperationCanceledException` propagate, and clean up in `finally`.

## Verifying the upload

For block blobs, the per-block MD5 is verified by the service automatically when you set `TransactionalContentHash` -- but the SDK only sets it for the single-PUT path, not the staged-block path. To verify integrity end-to-end with chunked uploads, set the whole-blob hash in `BlobHttpHeaders.ContentHash`. The service stores it and returns it on `Get Blob Properties`, but does **not** validate it on upload. You have to compute it on the client and re-check on download.

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

Wrapping the source in a `CryptoStream` adds CPU cost (~600 MB/s of SHA-256 on modern hardware) but is the only way to compute the hash without buffering. Skip it if the channel is HTTPS and you trust Azure's transport-level integrity.

## Things that quietly buffer

Even with the right SDK call, three patterns will resurrect the memory problem you were trying to avoid:

1. `Stream.CopyToAsync(memoryStream)` "to inspect headers". Do not do this for anything bigger than a few MiB. If you need the leading bytes, read into a stack-allocated `Span<byte>` and `Stream.Position = 0` only if the stream supports seeking. Most network-backed streams do not, in which case use a small `BufferedStream`.
2. Logging the request body. Serilog/NLog body-capture middleware may buffer the entire payload to make it loggable. Disable it for upload routes.
3. Returning `IActionResult` after the upload by setting `Response.Body` headers. The framework's `ObjectResult` formatter may serialize a status object back into a buffered response. Return `Results.Ok()` or `NoContent()` after a streaming upload, not a large object.

The "is it actually streaming" sanity check is to watch the process's working set during a 5 GiB upload. With the SDK and `StorageTransferOptions` configured as in this post, the working set should hover around `MaximumTransferSize * MaximumConcurrency + ~50 MiB` of overhead. Anything growing linearly with the upload size is a bug somewhere in your pipeline.

## Related

- [Stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers the download-side mirror image of this post.
- [Read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) walks through bounded-buffer streaming for parsing, which composes well with the upload pattern here when transforming on the way to blob storage.
- [Cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) goes deeper on `CancellationToken` propagation, which matters for any multi-minute upload.
- [Use `IAsyncEnumerable<T>` with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) for the streaming-export case where rows from EF Core feed straight into a blob.

## Source links

- [Azure.Storage.Blobs 12.22 release notes](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [Block blob scalability targets](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [Put Block REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [`StorageTransferOptions` reference](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [ASP.NET Core large-file upload guidance](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
