---
title: "How to Create and Extract ZIP Files Asynchronously with the ZipArchive Async APIs in .NET 11"
description: "Use ZipFile.CreateFromDirectoryAsync, ExtractToDirectoryAsync, ZipArchive.CreateAsync and ZipArchiveEntry.OpenAsync without hidden synchronous I/O. Measured on .NET 11 RC 1 and .NET 10.0.12, including the .NET 10 bug that still blocks Kestrel."
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
---

**Short answer:** for whole folders, call `await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` and `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)`. For control over each entry, open the archive with `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` instead of the constructor, open entries with `await entry.OpenAsync(ct)`, and dispose both the entry stream and the archive with `await using`. Skip any one of those three `await`s and `System.IO.Compression` quietly falls back to synchronous I/O. The async APIs shipped in .NET 10, but .NET 10 (still true on 10.0.12) does synchronous writes when an entry stream is disposed, even under `await using`. Only .NET 11 (measured on RC 1, `11.0.0-rc.1.26425.128`) is async end to end.

Everything below was run on an Apple M4 against two runtimes: .NET 10.0.12 (the current servicing release, built with SDK 10.0.302) and .NET 11 RC 1. The probes wrap the target stream in a `Stream` that throws on every synchronous `Read`, `Write` and `Flush`. That's the same contract Kestrel enforces on request and response bodies, so any hidden sync call shows up as an exception rather than a blocked thread you never notice.

## The async surface, and why there is no async constructor

The API came from [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541), a request filed back in the corefx days, and was implemented in [PR #114421](https://github.com/dotnet/runtime/pull/114421) for .NET 10. The [approved shape](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) is smaller than the original proposal, and the reasoning explains most of the gotchas:

- The `ZipArchive` constructor does I/O (it reads the end-of-central-directory record in read mode), and constructors cannot be awaited. So there is a static `ZipArchive.CreateAsync` factory.
- There is no `GetEntriesAsync`. `CreateAsync` is supposed to read the central directory before it returns, so the synchronous `Entries` property only hands back what is already in memory.
- There is no `CreateEntryAsync` or `DeleteAsync`, because `CreateEntry` and `Delete` do no I/O.
- `ZipArchive` implements `IAsyncDisposable`, because disposing a writable archive writes the central directory.

Here is how the synchronous calls map to their async versions (all take an optional `CancellationToken`):

| Synchronous | Asynchronous (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (path or `Stream` destination) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (path or `Stream` source) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

.NET 11 adds more overloads on top of this: `OpenAsync(ReadOnlySpan<char> password, ...)`, `OpenAsync(FileAccess, ...)`, `CreateEntryFromFileAsync` with a password and `ZipEncryptionMethod`, and `ZipFileCreationOptions` / `ZipExtractionOptions` overloads for the directory helpers. I listed all of these by reflecting over `System.IO.Compression` on both runtimes. The password side is covered in [the post on encrypted ZIPs in .NET 11](/2026/08/dotnet-11-preview-7-password-protected-zip-archives/).

## Steps to go fully async

1. Use the `ZipFile.*Async` directory helpers when you don't need per-entry control.
2. Otherwise, create the archive with `await ZipArchive.CreateAsync(...)` or `await ZipFile.OpenAsync(...)`, never `new ZipArchive(...)`.
3. Open every entry with `await entry.OpenAsync(ct)`, or use `CreateEntryFromFileAsync` / `ExtractToFileAsync`.
4. Dispose each entry stream with `await using`, before the archive is disposed.
5. Dispose the archive with `await using`.
6. Pass one `CancellationToken` through all of it, and decide what a cancelled extraction should leave on disk.

## Zipping and unzipping a whole folder

When the archive should mirror a directory, the static helpers do everything:

```csharp
// .NET 10+, C# 14 (tested on .NET 11 RC 1 and .NET 10.0.12)
using System.IO.Compression;

using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

// Folder -> .zip file
await ZipFile.CreateFromDirectoryAsync(
    "out/reports", "reports.zip",
    CompressionLevel.Optimal, includeBaseDirectory: false,
    cancellationToken: cts.Token);

// .zip file -> folder
await ZipFile.ExtractToDirectoryAsync(
    "reports.zip", "in/reports",
    overwriteFiles: true, cancellationToken: cts.Token);
```

Both helpers have `Stream` overloads too, which is how you zip straight into a network stream or unzip an upload without a temporary file. [The .NET 8 post on ZIP files to Stream](/2023/11/c-zip-files-to-stream/) introduced the synchronous `Stream` overloads, and the async versions have the same shape plus a token.

## Building an archive entry by entry

As soon as you need to filter, rename, or generate content, drop down to `ZipArchive`. All three `await`s matter here:

```csharp
// .NET 11 RC 1, C# 14
using System.IO.Compression;
using System.Text;

static async Task WriteExportAsync(Stream destination, IEnumerable<string> files, CancellationToken ct)
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        destination, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    // Files from disk, renamed and filtered
    foreach (string path in files.Where(f => !f.EndsWith(".tmp")))
    {
        await zip.CreateEntryFromFileAsync(
            path, $"data/{Path.GetFileName(path)}", CompressionLevel.Fastest, ct);
    }

    // Generated content
    ZipArchiveEntry manifest = zip.CreateEntry("manifest.txt", CompressionLevel.Optimal);
    await using (Stream s = await manifest.OpenAsync(ct))
    {
        await s.WriteAsync(Encoding.UTF8.GetBytes($"created={DateTime.UtcNow:O}\n"), ct);
    }
}
```

Scope the entry stream in its own `await using` block, as shown above, so it is disposed before the next entry is created. In `Create` mode only one entry can be open at a time, and disposing the entry stream flushes the last compressed block and writes the entry's sizes and CRC.

Reading works the same way. `Entries` is a plain property, and on .NET 11 it no longer does I/O after `CreateAsync`:

```csharp
// .NET 11 RC 1, C# 14
await using ZipArchive zip = await ZipFile.OpenReadAsync("reports.zip", ct);

foreach (ZipArchiveEntry entry in zip.Entries)
{
    if (entry.FullName.EndsWith('/')) continue; // directory entry

    await using Stream source = await entry.OpenAsync(ct);
    await using FileStream target = new(
        Path.Combine("in", entry.Name), FileMode.Create, FileAccess.Write,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous);
    await source.CopyToAsync(target, ct);
}
```

If you write paths from `entry.FullName` yourself, you also take on the path validation that `ExtractToDirectoryAsync` does for you. The helper refuses entries that would land outside the destination directory, while hand-rolled code does whatever `Path.Combine` tells it to.

## What each `await` actually buys you, measured

Here is the probe matrix. "Throws" means the archive code made at least one synchronous call on a stream that forbids them. The streams are non-seekable unless the row says otherwise, like a Kestrel body.

| Scenario | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | throws | throws |
| `CreateAsync` + `OpenAsync` + `await using` everywhere | **throws** | works |
| Same, but `using` on the archive | throws | throws |
| Same, but `using` on the entry stream | throws | throws |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **throws** | works |
| `new ZipArchive` (Read) | throws | throws |
| `CreateAsync` (Read) | works | works |
| `CreateAsync` (Read), seekable stream | **throws** | works |
| `CreateAsync` (Read), seekable, sync `entry.Open()` | throws | throws |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | works | works |
| `CreateAsync` (Update) on a non-seekable stream | `ArgumentException` | `ArgumentException` |

Two takeaways. First, the rows that throw on .NET 11 are all cases where you left a synchronous call in: the constructor, `Open()` in read mode, or a plain `using`. `Dispose()` has to flush compressed data and write the central directory, and it can't do that asynchronously. Second, the bold rows are .NET 10 bugs, not your mistakes.

## The .NET 10 bug: `await using` still writes synchronously

On .NET 10 the internal `WrappedStream` that `OpenAsync` returns in create mode does not override `DisposeAsync`. The base `Stream.DisposeAsync` calls `Dispose()`, so the whole chain underneath disposes synchronously and `DeflateStream` flushes its last block with a sync `Write`. The stack from my .NET 10.0.12 probe:

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

The read-side bug is similar: on a seekable stream, .NET 10's `CreateAsync` reads only the end-of-central-directory record and leaves the central directory for the first `Entries` access, which runs `ReadCentralDirectory()` synchronously. Non-seekable streams escape that bug by accident, because `CreateAsync` first copies them into a `MemoryStream` with async reads.

Both were reported as [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") and fixed in [PR #121938](https://github.com/dotnet/runtime/pull/121938), merged December 1, 2025 with the 11.0.0 milestone. The fix is 18 lines: a real `DisposeAsync` on `WrappedStream`, plus an eager `EnsureCentralDirectoryReadAsync` in `CreateAsync` for read mode. There is no `release/10.0` backport. The .NET 10 servicing releases up to 10.0.12 still fail, and I reproduced that on 10.0.10 and 10.0.12.

With a `FileStream` you would never notice, because a sync write just blocks a thread-pool thread for a moment. Kestrel is different.

## Streaming a ZIP from an ASP.NET Core endpoint

This is the case most people actually care about: build the archive directly into `Response.Body`, with no temp file and no `MemoryStream`.

```csharp
// .NET 11 RC 1, ASP.NET Core 11 minimal API
using System.IO.Compression;

app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.ContentType = "application/zip";
    ctx.Response.Headers.ContentDisposition = "attachment; filename=\"export.zip\"";

    await using ZipArchive zip = await ZipArchive.CreateAsync(
        ctx.Response.Body, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    foreach (string file in Directory.EnumerateFiles(exportFolder))
        await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
});
```

I ran it against a folder of 100 files (64 KB each) on both runtimes:

- **.NET 11 RC 1:** `200`, 3,499,034 bytes, and `unzip -l` lists all 100 files.
- **.NET 10.0.10:** `200`, **130 bytes**. The first entry's local header went out, then `DisposeAsync` hit the sync write, Kestrel logged `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.`, and the connection was cut. `unzip -t` reports `invalid compressed data to inflate`.

That second result is the dangerous one. The status code had already been sent, so the client sees a successful download of a corrupt file. The same endpoint written with `new ZipArchive(...)` fails on both runtimes, but at least it fails with a `500`, before any bytes are written. For more on that exception, see [fixing "Synchronous operations are disallowed"](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

If you are stuck on .NET 10, build the archive in an asynchronous temp file, then copy it out:

```csharp
// .NET 10 workaround (verified on 10.0.10): the ZIP code does sync I/O against the temp file, never against Kestrel
app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    await using var tmp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);

    await using (ZipArchive zip = await ZipArchive.CreateAsync(tmp, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct))
    {
        foreach (string file in Directory.EnumerateFiles(exportFolder))
            await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
    }

    tmp.Position = 0;
    ctx.Response.ContentType = "application/zip";
    ctx.Response.ContentLength = tmp.Length;
    await tmp.CopyToAsync(ctx.Response.Body, ct);
});
```

That returned a valid 3.5 MB archive on .NET 10.0.10, and you also get a real `Content-Length`. The alternative, setting `IHttpBodyControlFeature.AllowSynchronousIO = true` for the request, works but blocks a thread per download. For more on keeping large responses off the heap, see [streaming a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Extracting an uploaded ZIP from the request body

The other direction works on both runtimes, because the request body is not seekable:

```csharp
// .NET 10+ (tested on 10.0.10 and 11 RC 1)
app.MapPost("/import", async (HttpRequest req, CancellationToken ct) =>
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        req.Body, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: null, ct);

    long total = 0;
    foreach (ZipArchiveEntry entry in zip.Entries)
    {
        await using Stream s = await entry.OpenAsync(ct);
        var buffer = new byte[81920];
        int read;
        while ((read = await s.ReadAsync(buffer, ct)) > 0) total += read;
    }
    return Results.Ok(new { entries = zip.Entries.Count, bytes = total });
});
```

Posting the 100-file archive returned `{"entries":100,"bytes":6553600}`, while the `new ZipArchive(req.Body, ZipArchiveMode.Read)` version returned `500` with the `ReadAsync` flavour of the same exception. There's a catch: a ZIP's index sits at the end of the file, so read mode over a non-seekable stream first copies **the entire archive into memory**. My 32 MB test archive took 253 async reads before the first entry was available. For large uploads, stream the body to a `FileOptions.Asynchronous` temp file first (and check your [request size limits](/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)), then open that. Just remember that on .NET 10 a seekable source brings back the synchronous `Entries` read.

## Gotchas worth knowing before you ship

**Cancellation leaves a half-extracted directory.** I cancelled `ExtractToDirectoryAsync` on a 1,000-entry archive after 20 ms. It threw `OperationCanceledException` with 129 files on disk, one of them truncated (on .NET 10.0.12 it was 181 files). A second call without `overwriteFiles: true` then fails with `IOException: The file '.../f539.bin' already exists.` If partial output matters, extract into a temporary sibling directory and `Directory.Move` it into place only after the task completes. How the token flows is covered in [propagating a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Async is not faster.** It frees threads while waiting on I/O, and that's all. Zipping 1,000 files (64 MB) and extracting the result, median of 7 `Stopwatch` runs on local SSD (not a BenchmarkDotNet run):

| Operation | .NET 11 RC 1 sync | .NET 11 RC 1 async | .NET 10.0.12 sync | .NET 10.0.12 async |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

Compression is CPU work, and async file I/O on a fast local disk adds a little overhead. Use the async APIs on servers and UI threads, where a blocked thread costs something. A console tool that zips a build output gains nothing from them.

**Update mode is still a special case.** `ZipArchiveMode.Update` requires a stream that can read, write and seek (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`), and it loads entries into memory as you open them. It works with `CreateAsync` and `await using` on a seekable stream, but for large archives it is usually cheaper to write a new archive.

**Sync `Open()` isn't always harmless.** On .NET 11, a synchronous `entry.Open()` in create mode happened to work in my probe, because opening a new entry does no I/O. In read mode it throws against a no-sync stream on both runtimes. Just use `OpenAsync` everywhere and stop keeping track.

**Implementing `IAsyncDisposable` yourself?** The .NET 10 bug is a textbook example of a wrapper that forgot to forward `DisposeAsync`. [Implementing and consuming IAsyncDisposable](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) walks through getting that right.

### Read next

- [Fix: InvalidOperationException: Synchronous operations are disallowed in ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [System.IO.Compression reads and writes encrypted ZIPs in .NET 11](/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [How to implement and consume IAsyncDisposable with await using in C#](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### Sources

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) and the [approved API shape](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [ZipArchive.CreateAsync on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [ZipFile.ExtractToDirectoryAsync on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
