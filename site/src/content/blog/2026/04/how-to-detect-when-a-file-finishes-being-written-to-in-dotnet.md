---
title: "How to detect when a file finishes being written to in .NET"
description: "FileSystemWatcher fires Changed before the writer is done. Three reliable patterns for .NET 11 to know a file is fully written: open with FileShare.None, debounce with size stabilization, and the producer-side rename trick that avoids the problem entirely."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
---

`FileSystemWatcher` does not tell you when a file is "done". It tells you the OS observed a change. On Windows, `WriteFile` calls each fire a `Changed` event, and `Created` fires the moment the file appears, often before a single byte is written. The reliable patterns are: (1) try to open the file with `FileShare.None` and treat `IOException` 0x20 / 0x21 as "still being written", retrying with backoff; (2) poll `FileInfo.Length` and `LastWriteTimeUtc` until both stabilize across two consecutive samples; or (3) cooperate with the producer so it writes to `name.tmp` and then `File.Move` to the final name, which is atomic on the same volume. Pattern 3 is the only one that is correct without races. Patterns 1 and 2 are how you survive when you do not control the producer.

This post targets .NET 11 (preview 4) and Windows / Linux / macOS. The `FileSystemWatcher` semantics described below have not changed since .NET Core 3.1 on any platform, and the cooperative rename trick is the same on POSIX and NTFS.

## Why the obvious approach is wrong

The naive code looks like this and is in production at far too many places:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` fires when the OS reports the directory entry exists. The writing process has not necessarily flushed even one byte. On Windows the file may be open with `FileShare.Read` (so your read returns a partial file) or with `FileShare.None` (so your read throws `IOException: The process cannot access the file because it is being used by another process`, HRESULT `0x80070020`, win32 error 32). On Linux you almost always get a partial read because there is no mandatory locking by default; you'll silently process half a CSV.

`Changed` is worse. Depending on how the producer writes, you can get one event per `WriteFile` call, which means a 1 MB file written in 4 KB chunks fires 256 events. None of them tell you the writer is finished. There is no `WriteFileLastTimeIPromise` notification because the kernel does not know the writer's intent.

A third problem: many copy tools (Explorer, `robocopy`, rsync) write to a hidden temp name first and then rename. You'll see `Created` for the temp, then `Renamed` for the final file. The `Renamed` event is the one you want to react to in those cases, but `FileSystemWatcher.NotifyFilter` defaults exclude `LastWrite` on .NET 11 and on some platforms exclude `FileName`, so you have to opt in.

## Pattern 1: Open with FileShare.None and back off

If you do not control the producer, your only observation channel is "can I open the file exclusively". The producer holds an open handle while writing; once it closes the handle, an exclusive open succeeds. This works on Windows, Linux, and macOS (Linux gives you advisory locks via `flock`, but the open-without-lock semantics for a regular `FileStream` are sufficient because we are reading just to confirm the writer is gone).

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

Three subtle things:

- **Catch `IOException`, not `Exception`**. `UnauthorizedAccessException` (ACLs) and `FileNotFoundException` (the producer aborted and deleted the file) are different bugs and should not be retried.
- **Inspect `HResult`**. On .NET Core and later, `IOException.HResult` is the standard win32 error wrapped in `0x8007xxxx` on Windows, and the same numeric codes are surfaced on POSIX systems via the runtime's translation layer. Sharing violation is `0x20`; lock violation is `0x21`. Do not match on the message string -- it is localized.
- **Exponential backoff with a cap**. If the producer stalls (network upload, slow USB), polling at 50ms uses CPU for nothing. Capping at 1 second keeps the worker quiet without hurting latency for fast writes.

This pattern fails for one specific case: a producer that opens with `FileShare.Read | FileShare.Write` (some buggy uploaders do this). Your exclusive open will succeed mid-write and you'll read garbage. If you suspect this, combine pattern 1 with pattern 2.

## Pattern 2: Debounce on size stabilization

When you cannot rely on file locks (some Linux producers, some SMB shares, some camera dumps), poll size and `LastWriteTimeUtc`. The rule of thumb: if the size is unchanged for two consecutive polls separated by a sane interval, the writer has likely finished.

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

Pick `pollInterval` based on what you know about the writer:

- Local fast disk, small file: 100ms, 2 samples.
- Network upload over 100 Mb link: 1s, 3 samples.
- USB / SD card / SMB: 2s, 3 samples (filesystem caching can mask momentary completion).

The trap is `FileInfo.Refresh()`. Without it, `FileInfo.Length` returns the value cached when the `FileInfo` was constructed, and your loop spins forever. There is no compiler warning for this; it is a common silent bug.

Combine with pattern 1 for production: poll for stable size, then attempt an exclusive open as the final confirmation. The combination handles both well-behaved and misbehaved producers.

## Pattern 3: The producer cooperates -- write, then rename

If you control the writer, you do not need to detect anything. Write to `final.csv.tmp`, fsync, close, and rename to `final.csv`. The consumer's `FileSystemWatcher` watches for `Renamed` (or `Created` of the final extension) and reacts. On the same NTFS or ext4 volume, `File.Move` is atomic: either the destination exists with the complete payload, or it does not exist at all.

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

Two non-obvious rules:

- **Same volume**. Atomic rename only works within one filesystem. Writing the temp to `C:\temp\x.tmp` and renaming to `D:\inbox\x.csv` is a copy-and-delete behind the scenes, and the consumer can absolutely catch it mid-copy. Always stage the `.tmp` in the destination directory.
- **Same extension family**. If your watcher filter is `*.csv` and the producer creates `x.csv.tmp`, the watcher will not fire on the temp file, which is what you want. If the watcher filter is `*` you'll get a `Created` event for the temp; ignore anything ending in `.tmp` in your handler.

This is the same pattern Git uses for ref updates, the same pattern SQLite uses for its journal, and the same pattern atomic config reloaders (nginx, HAProxy) use. There is a reason. If you can change the producer, do this and stop reading.

## Tying it to FileSystemWatcher correctly

The handler should be cheap and offload to a queue. `FileSystemWatcher` raises events on a thread pool thread with a small internal buffer (default 8 KB on Windows). If you block in the handler, the buffer overflows and you get `Error` events with `InternalBufferOverflowException`, dropping events silently.

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

Three things in there that catch people:

- **`InternalBufferSize`**. The default 8 KB is too small for any real workload. Bump it to the platform max (64 KB on Windows; the Linux inotify backend pulls from `/proc/sys/fs/inotify/max_queued_events`). The cost is process memory you'll never notice.
- **`NotifyFilter`**. The .NET 11 default is `LastWrite | FileName | DirectoryName`, but on macOS the kqueue backend ignores some flags; opt in to `Size` explicitly so size-only changes (a writer using `WriteFile` with no metadata change) trigger events.
- **A `Channel<T>` decouples the watcher from the consumer**. If the consumer takes 5 seconds to process a file and 100 events arrive in that window, the channel buffers them while the watcher returns immediately. See [why Channels beat BlockingCollection for this kind of producer / consumer split](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## When the file is over a network share

SMB and NFS add their own timing. `FileSystemWatcher` on a UNC path on Windows uses `ReadDirectoryChangesW` against the share, but the events are coalesced by the SMB redirector. You may see one `Changed` event per minute even for a continuously written 1 GB file. Patterns 1 and 2 still work, but you should set `pollInterval` to something on the order of 5-10 seconds; polling a remote `FileInfo.Length` every 100ms generates a metadata round-trip per poll and saturates the link.

NFS is worse: `inotify` does not fire for changes made on other clients, only for changes to the local mount made by local processes. If your consumer is on host A and the producer is on host B writing through NFS, `FileSystemWatcher` will see nothing. The fix is polling-only -- `Directory.EnumerateFiles` on a timer, with patterns 1 and 2 applied to each new entry. There is no kernel notification path that will save you here.

## Common edge cases

- **The producer truncates and rewrites in place**. `FileSystemWatcher` will fire a single `Changed` event when the new content lands. Pattern 2's stable-size check handles this correctly because the size only stabilizes after the rewrite completes. Pattern 1 may briefly succeed during the truncate window when the file is empty; combine with a minimum-expected-size check if your domain has one.
- **Antivirus locks the file after creation**. Defender (Windows) and most enterprise AV products open the file for scanning when it appears, holding `FileShare.Read` for tens to hundreds of milliseconds. Pattern 1's retry loop absorbs this transparently; just do not set the timeout to 100ms.
- **The file is created by a process that crashes**. You'll see `Created`, possibly `Changed`, and then nothing. Pattern 2's stable-size check returns true after the polling window because no further writes happen. You'll then process a partial file. Have the producer cooperate (pattern 3) or have a sentinel file (`final.csv.done`) the producer touches at the end.
- **Multiple files written in lockstep** (e.g., `data.csv` plus `data.idx`). Watch for the secondary file's appearance, not the primary's. The producer is responsible for writing the index after the data, so the index appearing implies the data is complete.

## Related reading

- [Streaming a file out of ASP.NET Core without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers the read side once you've confirmed the file is complete.
- [Reading large CSVs without OOM](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) is the natural follow-up if your inbox files are big.
- [Cancelling long-running tasks without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) applies to the wait loops above when you want them to honour shutdown.
- [Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) is the right transport between the watcher and the worker.

## Sources

- [`FileSystemWatcher` reference, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- the platform notes section is the most useful.
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- documents the atomic rename overload added in .NET Core 3.0.
- [Win32 `MoveFileEx` documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- the underlying primitive used by `File.Move(overwrite: true)`.
- [`ReadDirectoryChangesW` API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- explains the buffer overflow conditions that translate to `InternalBufferOverflowException`.
