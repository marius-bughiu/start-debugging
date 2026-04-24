---
title: "How to stream a file from an ASP.NET Core endpoint without buffering"
description: "Serve large files from ASP.NET Core 11 without loading them into memory. Three tiers: PhysicalFileResult for on-disk files, Results.Stream for arbitrary streams, and Response.BodyWriter for generated payloads -- with code for each."
pubDate: 2026-04-24
tags:
  - "aspnet-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "streaming"
---

Use `PhysicalFileResult` (or `Results.File(path, contentType)` in minimal APIs) for files already on disk -- Kestrel calls the OS `sendfile` syscall under the hood, so the file bytes never touch managed memory. For streams that don't exist on disk -- Azure Blob, an S3 object, a dynamically generated archive -- return a `FileStreamResult` or `Results.Stream(factory, contentType)` and open the underlying `Stream` lazily inside the factory delegate. For fully generated payloads, write directly to `HttpContext.Response.BodyWriter`. In all three cases the one pattern that silently kills scalability is copying the source into a `MemoryStream` first: that forces the entire payload onto the managed heap, typically on the Large Object Heap, before a single byte reaches the client.

This post targets .NET 11 and ASP.NET Core 11 (preview 3). Everything in tiers 1 and 2 has worked since .NET 6; the `BodyWriter` approach became ergonomic with `System.IO.Pipelines` stable APIs in .NET 5 and has not changed since.

## Why response buffering is different from what you think

When people say "stream a file", they usually mean "don't read it all into memory". That is right, but there is a second half: don't buffer the response either. ASP.NET Core's output-caching and response compression middleware can re-introduce buffering transparently. If you use `AddResponseCompression` and haven't tuned it, small files (under the default 256-byte threshold) are never compressed, but large files are fully buffered into a `MemoryStream` before the compressed bytes are written. The fix for large files is either to compress at the CDN layer or to set `MimeTypes` on `ResponseCompressionOptions` conservatively and exclude binary content types from compression entirely.

Response buffering also happens inside the framework when you return an `IResult` or `ActionResult` from a controller action: the framework writes status and headers first, then calls `ExecuteAsync` on the result, which is where the actual byte transfer occurs. In .NET 6, `Results.File(path, ...)` called `PhysicalFileResultExecutor.WriteFileAsync`, which delegated to `IHttpSendFileFeature.SendFileAsync` -- the zero-copy path. In .NET 7 a refactoring introduced a regression where `Results.File` wrapped the `FileStream` in a `StreamPipeWriter`, bypassing `IHttpSendFileFeature` and causing the kernel to copy file pages into userspace unnecessarily (tracked as [issue #45037](https://github.com/dotnet/aspnetcore/issues/45037)). That regression was fixed, but it illustrates that the "correct" result type matters for performance, not just correctness.

## Tier 1: Files already on disk

For files on disk the right return type is `PhysicalFileResult` in MVC controllers, or `Results.File(physicalPath, contentType)` in minimal APIs. Both take a physical path string rather than a `Stream`, which lets the executor check whether `IHttpSendFileFeature` is available on the current transport. Kestrel on Linux exposes this feature and uses `sendfile(2)` -- the bytes go from the OS page cache directly into the socket buffer without ever copying into the .NET process. On Windows, Kestrel uses `TransmitFile` through an I/O completion port with the same effect.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API
app.MapGet("/downloads/{filename}", (string filename, IWebHostEnvironment env) =>
{
    string physicalPath = Path.Combine(env.ContentRootPath, "downloads", filename);

    if (!File.Exists(physicalPath))
        return Results.NotFound();

    return Results.File(
        physicalPath,
        contentType: "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
});
```

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller
[HttpGet("downloads/{filename}")]
public IActionResult Download(string filename)
{
    string physicalPath = Path.Combine(_env.ContentRootPath, "downloads", filename);

    if (!System.IO.File.Exists(physicalPath))
        return NotFound();

    return PhysicalFile(
        physicalPath,
        "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
}
```

Two notes about the path. First, do not pass user-supplied filenames directly to `Path.Combine` without sanitising them. The code above is a skeleton: validate that the resolved path is still inside the allowed directory before calling `File.Exists`. Second, `IWebHostEnvironment.ContentRootPath` resolves to the app's working directory, not `wwwroot`. For public static assets, the static file middleware with `app.UseStaticFiles()` already handles range requests and ETags, and you should prefer it over a manual endpoint for files in `wwwroot`.

## Tier 2: Streaming from an arbitrary Stream

The S3 object, the Azure Blob, the database `varbinary(max)` column -- these all come back as a `Stream` that has no corresponding path on disk, so `PhysicalFileResult` does not apply. The correct type here is `FileStreamResult` in controllers, or `Results.Stream` in minimal APIs.

The critical detail is to open the `Stream` lazily. `Results.Stream` accepts a `Func<Stream>` factory overload; use it so the stream is not opened until after the response headers are written and the connection is confirmed alive. If the factory throws (for example, because the blob no longer exists), the framework can still return a 404 before headers are committed.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- streaming from Azure Blob Storage
app.MapGet("/blobs/{blobName}", async (
    string blobName,
    BlobServiceClient blobService,
    CancellationToken ct) =>
{
    var container = blobService.GetBlobContainerClient("exports");
    var blob = container.GetBlobClient(blobName);

    if (!await blob.ExistsAsync(ct))
        return Results.NotFound();

    BlobProperties props = await blob.GetPropertiesAsync(cancellationToken: ct);

    return Results.Stream(
        streamWriterCallback: async responseStream =>
        {
            await blob.DownloadToAsync(responseStream, ct);
        },
        contentType: props.ContentType,
        fileDownloadName: blobName,
        lastModified: props.LastModified,
        enableRangeProcessing: false); // Azure handles ranges upstream; disable double-processing
});
```

`Results.Stream` has two overloads: one takes a `Stream` directly, the other takes a `Func<Stream, Task>` callback (shown above). Prefer the callback form when the source is a network stream, because it defers the I/O until the framework is ready to write the response body. The callback receives the response body `Stream` as its argument; write your source data into it.

For controllers, `FileStreamResult` requires you to pass the stream directly. Open it as late as possible in the action method, and use `FileOptions.Asynchronous | FileOptions.SequentialScan` when opening `FileStream` instances to avoid blocking the thread pool:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- streaming from local filesystem via FileStreamResult
[HttpGet("exports/{id}")]
public async Task<IActionResult> GetExport(Guid id, CancellationToken ct)
{
    string? path = await _exportService.GetPathAsync(id, ct);

    if (path is null)
        return NotFound();

    var fs = new FileStream(
        path,
        new FileStreamOptions
        {
            Mode    = FileMode.Open,
            Access  = FileAccess.Read,
            Share   = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    return new FileStreamResult(fs, "application/octet-stream")
    {
        FileDownloadName    = $"{id}.bin",
        EnableRangeProcessing = true,
    };
}
```

The framework disposes `fs` after the response is sent. You do not need a `using` block around it.

## Tier 3: Writing generated content to the response pipe

Sometimes the content does not exist anywhere -- it is generated on the fly: a report rendered to PDF, a CSV assembled from query results, a ZIP created from selected files. The naive approach is to render into a `MemoryStream` and then return it as a `FileStreamResult`. That works, but the entire payload has to be in memory before the client receives the first byte. For a 200 MB export that is 200 MB on the Large Object Heap per concurrent request.

The correct approach is to write directly to `HttpContext.Response.BodyWriter`, which is a `PipeWriter` backed by a pool of 4 KB buffers. The framework flushes to the socket incrementally; memory usage is bounded by the in-flight window, not the file size.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- streaming a generated CSV report
app.MapGet("/reports/{year:int}", async (
    int year,
    ReportService reports,
    HttpContext ctx,
    CancellationToken ct) =>
{
    ctx.Response.ContentType = "text/csv";
    ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"report-{year}.csv\"";

    var writer = ctx.Response.BodyWriter;

    await writer.WriteAsync("id,date,amount\n"u8.ToArray(), ct);

    await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
    {
        string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
        await writer.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
    }

    await writer.CompleteAsync();
    return Results.Empty;
});
```

Note the use of `"id,date,amount\n"u8.ToArray()` -- a UTF-8 string literal introduced in C# 11, producing a `byte[]` with no allocation. For the row lines, `Encoding.UTF8.GetBytes(line)` still allocates; to eliminate that, request a buffer from the writer directly:

```csharp
// .NET 11, C# 14 -- zero-allocation write using PipeWriter.GetMemory
await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
{
    string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
    int byteCount = Encoding.UTF8.GetByteCount(line);
    Memory<byte> buffer = writer.GetMemory(byteCount);
    int written = Encoding.UTF8.GetBytes(line, buffer.Span);
    writer.Advance(written);
    await writer.FlushAsync(ct);
}
```

`GetMemory` / `Advance` / `FlushAsync` is the canonical `PipeWriter` pattern. `FlushAsync` returns a `FlushResult` that tells you if the downstream consumer has cancelled or completed (`FlushResult.IsCompleted`); in a well-behaved client this is rarely true during a download, but checking it inside the loop lets you exit early if the client disconnects.

Because you are writing the response body directly, you cannot return a status code after the first `FlushAsync` call commits the headers. Set `ctx.Response.StatusCode` before writing any bytes. If your service call can fail in a way that should produce a 500, check it before touching `BodyWriter`.

For ZIP generation specifically, .NET 11 (through `System.IO.Compression`) lets you create a `ZipArchive` that writes into any writable stream. Pass a `StreamWriter` that wraps `ctx.Response.Body` (not `BodyWriter` directly, since `ZipArchive` expects a `Stream`, not a `PipeWriter`). The approach is covered in the [C# ZIP files to Stream post](/2023/11/c-zip-files-to-stream/), which uses the newer `CreateFromDirectory` overload added in .NET 8. Similarly, if the export is Zstandard-compressed, chain the compressor stream before the response body -- the new built-in `ZstandardStream` in [.NET 11's Zstandard compression support](/2026/04/dotnet-11-zstandard-compression-system-io/) avoids a NuGet dependency.

## Range requests: resumable downloads for free

`EnableRangeProcessing = true` on `FileStreamResult` or `Results.File` instructs ASP.NET Core to parse `Range` request headers and respond with `206 Partial Content`. The framework handles everything: parsing the `Range` header, seeking the stream (for seekable streams), setting `Content-Range` and `Accept-Ranges` response headers, and sending only the requested byte range.

For `PhysicalFileResult`, range processing is always available because the framework controls the file handle. For `FileStreamResult`, range processing only works if the underlying `Stream.CanSeek` is `true`. Azure Blob streams returned from `BlobClient.OpenReadAsync` are seekable; raw `HttpResponseMessage.Content` streams usually are not. If seeking is not available, set `EnableRangeProcessing = false` (the default) and either serve without range support or buffer the relevant range yourself.

The feature is especially useful for large video or audio files served as downloads, and for resumable download managers. It also reduces server load when the client has already received part of the file and reconnects mid-transfer.

## Common mistakes that silently re-introduce buffering

**Returning `byte[]` from a controller action.** ASP.NET Core wraps it in a `FileContentResult`, which is fine for small files but terrible for large ones because the byte array is allocated before the action method returns.

**Calling `stream.ToArray()` or `MemoryStream.GetBuffer()` on a source stream.** Both materialise the entire stream. If you find yourself doing this before calling `Results.Stream`, you are negating the streaming.

**Setting `Response.ContentLength` incorrectly.** If `ContentLength` is set but the stream produces fewer bytes (because you aborted early), Kestrel will log a connection error. If it is set too small, the client will stop reading after `ContentLength` bytes and may consider the download complete even though bytes remain. For dynamically generated content where the length is unknown upfront, omit `ContentLength` and let the client use chunked encoding.

**Forgetting cancellation.** A 2 GB export takes minutes. Wiring `CancellationToken` through the `PipeWriter` flush loop lets the server clean up immediately when the client closes the connection. See the [how to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) post for the cancellation patterns that prevent deadlocks during stream teardown.

**Using `IAsyncEnumerable<byte[]>` from a controller.** ASP.NET Core's JSON formatter will try to serialise the byte arrays as Base64 JSON tokens rather than writing them raw. Only use `IAsyncEnumerable` at the application layer to feed a lower-level write loop; do not return it directly as the action result for binary content.

**Buffering compressed output.** `AddResponseCompression` with the default settings buffers the entire response to compress it, which undoes everything above for text content types. Either exclude your download content type from compression (`options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(...)`), compress the source before streaming (chain a `DeflateStream` or `ZstandardStream` ahead of the response pipe), or pre-compress at the CDN. The same memory concern applies to the CSV streaming pattern: if `Content-Type: text/csv` is in the compression mime-type list, the framework will buffer the whole generated CSV.

## Picking the right tier

On-disk file with known path: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`.

Blob or external stream: `Results.Stream(callback, contentType)` or `FileStreamResult` with a seekable stream.

Generated content: write to `ctx.Response.BodyWriter`, set headers before the first `FlushAsync`, and thread `CancellationToken` through the loop.

The common thread is to keep the pipeline open and let data flow through it. The moment you buffer the whole payload, you have moved from an O(1)-memory endpoint to an O(N)-memory one, and under concurrent load those N values stack up until the process dies.

For the same reason that streaming matters here, it matters when reading large inputs: the [how to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) post shows the identical trade-off from the ingestion side.

## Sources

- [FileStreamResult on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [Results.Stream on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [IHttpSendFileFeature.SendFileAsync on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [System.IO.Pipelines overview on MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore issue #45037 -- Results.File regression in .NET 7](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore issue #55606 -- FileStreamResult excess I/O](https://github.com/dotnet/aspnetcore/issues/55606)
- [Response compression in ASP.NET Core on MS Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
